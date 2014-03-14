'use strict';

var db = require('./database'),
	utils = require('./../public/src/utils'),
	user = require('./user'),
	topics = require('./topics'),
	favourites = require('./favourites'),
	postTools = require('./postTools'),
	categories = require('./categories'),
	plugins = require('./plugins'),
	meta = require('./meta'),

	async = require('async'),
	path = require('path'),
	fs = require('fs'),
	nconf = require('nconf'),
	validator = require('validator'),
	winston = require('winston'),
	gravatar = require('gravatar'),
	S = require('string');

(function(Posts) {
	var customUserInfo = {};

	Posts.create = function(data, callback) {
		var uid = data.uid,
			tid = data.tid,
			content = data.content,
			toPid = data.toPid;

		if (uid === null) {
			return callback(new Error('invalid-user'));
		}

		var timestamp = Date.now(),
			postData;

		async.waterfall([
			function(next) {
				db.incrObjectField('global', 'nextPid', next);
			},
			function(pid, next) {

				postData = {
					'pid': pid,
					'uid': uid,
					'tid': tid,
					'content': content,
					'timestamp': timestamp,
					'reputation': 0,
					'votes': 0,
					'editor': '',
					'edited': 0,
					'deleted': 0
				};

				if (toPid) {
					postData.toPid = toPid;
				}

				plugins.fireHook('filter:post.save', postData, next);
			},
			function(postData, next) {
				db.setObject('post:' + postData.pid, postData, next);
			},
			function(result, next) {
				db.sortedSetAdd('posts:pid', timestamp, postData.pid);

				db.incrObjectField('global', 'postCount');

				topics.onNewPostMade(tid, postData.pid, timestamp);
				categories.onNewPostMade(uid, tid, postData.pid, timestamp);
				user.onNewPostMade(uid, tid, postData.pid, timestamp);

				plugins.fireHook('filter:post.get', postData, next);
			},
			function(postData, next) {
				postTools.parse(postData.content, function(err, content) {
					if(err) {
						return next(err);
					}

					plugins.fireHook('action:post.save', postData);

					postData.content = content;

					next(null, postData);
				});
			}
		], callback);
	};

	Posts.getPostsByTid = function(tid, start, end, reverse, callback) {
		db[reverse ? 'getSortedSetRevRange' : 'getSortedSetRange']('tid:' + tid + ':posts', start, end, function(err, pids) {
			if(err) {
				return callback(err);
			}

			if(!Array.isArray(pids) || !pids.length) {
				return callback(null, []);
			}

			Posts.getPostsByPids(pids, function(err, posts) {
				if(err) {
					return callback(err);
				}

				if(!Array.isArray(posts) || !posts.length) {
					return callback(null, []);
				}

				plugins.fireHook('filter:post.getPosts', {tid: tid, posts: posts}, function(err, data) {
					if(err) {
						return callback(err);
					}

					if(!data || !Array.isArray(data.posts)) {
						return callback(null, []);
					}

					callback(null, data.posts);
				});
			});
		});
	};

	Posts.getPostsByPids = function(pids, callback) {
		var keys = [];

		for(var x=0, numPids=pids.length; x<numPids; ++x) {
			keys.push('post:' + pids[x]);
		}

		db.getObjects(keys, function(err, data) {
			if(err) {
				return callback(err);
			}

			async.map(data, function(postData, next) {
				if(!postData) {
					return next(null);
				}

				postData.relativeTime = utils.toISOString(postData.timestamp);
				postData.relativeEditTime = parseInt(postData.edited, 10) !== 0 ? utils.toISOString(postData.edited) : '';

				postTools.parse(postData.content, function(err, content) {
					if(err) {
						return next(err);
					}

					postData.content = content;
					next(null, postData);
				});

			}, callback);
		});
	};

	Posts.getPostsByUid = function(callerUid, uid, start, end, callback) {
		user.getPostIds(uid, start, end, function(err, pids) {
			if(err) {
				return callback(err);
			}

			async.filter(pids, function(pid, next) {
				postTools.privileges(pid, callerUid, function(err, privileges) {
					next(privileges.read);
				});
			}, function(pids) {
				if (!(pids && pids.length)) {
					return callback(null, { posts: [], nextStart: 0});
				}


				Posts.getPostSummaryByPids(pids, false, function(err, posts) {
					if(err) {
						return callback(err);
					}

					if(!posts || !posts.length) {
						return callback(null, { posts: [], nextStart: 0});
					}

					db.sortedSetRevRank('uid:' + uid + ':posts', posts[posts.length - 1].pid, function(err, rank) {
						if(err) {
							return callback(err);
						}
						var userPosts = {
							posts: posts,
							nextStart: parseInt(rank, 10) + 1
						};
						callback(null, userPosts);
					});
				});
			});
		});
	};

	Posts.getRecentPosts = function(uid, start, stop, term, callback) {
		var terms = {
			day: 86400000,
			week: 604800000,
			month: 2592000000
		};

		var since = terms.day;
		if (terms[term]) {
			since = terms[term];
		}

		var count = parseInt(stop, 10) === -1 ? stop : stop - start + 1;

		db.getSortedSetRevRangeByScore(['posts:pid', '+inf', Date.now() - since, 'LIMIT', start, count], function(err, pids) {
			if(err) {
				return callback(err);
			}

			async.filter(pids, function(pid, next) {
				postTools.privileges(pid, uid, function(err, privileges) {
					next(!err && privileges.read);
				});
			}, function(pids) {
				Posts.getPostSummaryByPids(pids, true, callback);
			});
		});
	};

	Posts.addUserInfoToPost = function(post, callback) {
		user.getUserFields(post.uid, ['username', 'userslug', 'reputation', 'postcount', 'picture', 'signature', 'banned'], function(err, userData) {
			if (err) {
				return callback(err);
			}

			post.user = {
				username: userData.username || 'anonymous',
				userslug: userData.userslug || '',
				reputation: userData.reputation || 0,
				postcount: userData.postcount || 0,
				banned: parseInt(userData.banned, 10) === 1,
				picture: userData.picture || gravatar.url('', {}, true)
			};

			for (var info in customUserInfo) {
				if (customUserInfo.hasOwnProperty(info)) {
					post.user[info] = userData[info] || customUserInfo[info];
				}
			}

			async.parallel({
				signature: function(next) {
					if (parseInt(meta.config.disableSignatures, 10) !== 1) {
						return postTools.parseSignature(userData.signature, next);
					}
					next();
				},
				editor: function(next) {
					if (!post.editor) {
						return next();
					}
					user.getUserFields(post.editor, ['username', 'userslug'], next);
				},
				customProfileInfo: function(next) {
					plugins.fireHook('filter:posts.custom_profile_info', {profile: [], uid: post.uid, pid: post.pid}, next);
				}
			}, function(err, results) {
				if (err) {
					return callback(err);
				}

				post.user.signature = results.signature;
				post.editor = results.editor;
				post.custom_profile_info = results.profile;

				callback(null, post);
			});
		});
	};

	Posts.getPostSummaryByPids = function(pids, stripTags, callback) {

		function getPostSummary(pid, callback) {

			async.waterfall([
				function(next) {
					Posts.getPostFields(pid, ['pid', 'tid', 'content', 'uid', 'timestamp', 'deleted'], function(err, postData) {
						if(err) {
							return next(err);
						}

						if (parseInt(postData.deleted, 10) === 1) {
							return callback(null);
						}

						postData.relativeTime = utils.toISOString(postData.timestamp);
						next(null, postData);
					});
				},
				function(postData, next) {
					Posts.addUserInfoToPost(postData, function() {
						next(null, postData);
					});
				},
				function(postData, next) {
					topics.getTopicFields(postData.tid, ['title', 'cid', 'slug', 'deleted'], function(err, topicData) {
						if (err) {
							return callback(err);
						} else if (parseInt(topicData.deleted, 10) === 1) {
							return callback(null);
						}
						categories.getCategoryFields(topicData.cid, ['name', 'icon', 'slug'], function(err, categoryData) {
							postData.category = categoryData;
							topicData.title = validator.escape(topicData.title);
							postData.topic = topicData;
							next(null, postData);
						});
					});
				},
				function(postData, next) {
					if (!postData.content) {
						return next(null, postData);
					}

					postTools.parse(postData.content, function(err, content) {
						if(err) {
							return next(err);
						}

						if(stripTags) {
							var s = S(content);
							postData.content = s.stripTags.apply(s, utils.getTagsExcept(['img', 'i', 'p'])).s;
						} else {
							postData.content = content;
						}

						next(null, postData);
					});
				}
			], callback);
		}

		async.map(pids, getPostSummary, function(err, posts) {
			if(err) {
				return callback(err);
			}

			posts = posts.filter(function(p) {
				return p;
			});

			callback(null, posts);
		});
	};

	Posts.getPostData = function(pid, callback) {
		db.getObject('post:' + pid, function(err, data) {
			if(err) {
				return callback(err);
			}

			plugins.fireHook('filter:post.get', data, callback);
		});
	};

	Posts.getPostFields = function(pid, fields, callback) {
		db.getObjectFields('post:' + pid, fields, function(err, data) {
			if(err) {
				return callback(err);
			}

			// TODO: I think the plugins system needs an optional 'parameters' paramter so I don't have to do this:
			data = data || {};
			data.pid = pid;
			data.fields = fields;

			plugins.fireHook('filter:post.getFields', data, callback);
		});
	};

	Posts.getPostField = function(pid, field, callback) {
		Posts.getPostFields(pid, [field], function(err, data) {
			if(err) {
				return callback(err);
			}

			callback(null, data[field]);
		});
	};

	Posts.setPostField = function(pid, field, value, callback) {
		db.setObjectField('post:' + pid, field, value, callback);
		plugins.fireHook('action:post.setField', {
			'pid': pid,
			'field': field,
			'value': value
		});
	};

	Posts.setPostFields = function(pid, data, callback) {
		db.setObject('post:' + pid, data, callback);
	};

	Posts.getCidByPid = function(pid, callback) {
		Posts.getPostField(pid, 'tid', function(err, tid) {
			if(err) {
				return callback(err);
			}

			topics.getTopicField(tid, 'cid', function(err, cid) {
				if(err || !cid) {
					return callback(err || new Error('invalid-category-id'));
				}
				callback(null, cid);
			});
		});
	};

	Posts.getFavourites = function(uid, start, end, callback) {
		db.getSortedSetRevRange('uid:' + uid + ':favourites', start, end, function(err, pids) {
			if (err) {
				return callback(err);
			}

			Posts.getPostSummaryByPids(pids, false, function(err, posts) {
				if(err) {
					return callback(err);
				}

				if(!posts || !posts.length) {
					return callback(null, { posts: [], nextStart: 0});
				}

				db.sortedSetRevRank('uid:' + uid + ':favourites', posts[posts.length - 1].pid, function(err, rank) {
					if(err) {
						return callback(err);
					}
					var favourites = {
						posts: posts,
						nextStart: parseInt(rank, 10) + 1
					};
					callback(null, favourites);
				});
			});
		});
	};

	Posts.getPidPage = function(pid, uid, callback) {
		if(!pid) {
			return callback(new Error('invalid-pid'));
		}

		var index = 0;
		async.waterfall([
			function(next) {
				Posts.getPidIndex(pid, next);
			},
			function(result, next) {
				index = result;
				user.getSettings(uid, next);
			},
			function(settings, next) {
				next(null, Math.ceil((index + 1) / settings.postsPerPage));
			}
		], callback);
	};

	Posts.getPidIndex = function(pid, callback) {
		Posts.getPostField(pid, 'tid', function(err, tid) {
			if(err) {
				return callback(err);
			}

			db.sortedSetRank('tid:' + tid + ':posts', pid, callback);
		});
	};

}(exports));
