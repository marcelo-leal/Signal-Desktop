/*
 * vim: ts=4:sw=4:expandtab
 */
(function () {
  'use strict';
   window.Whisper = window.Whisper || {};

   // TODO: Factor out private and group subclasses of Conversation

   var COLORS = [
        'red',
        'pink',
        'purple',
        'deep_purple',
        'indigo',
        'blue',
        'light_blue',
        'cyan',
        'teal',
        'green',
        'light_green',
        'orange',
        'deep_orange',
        'amber',
        'blue_grey',
    ];

  Whisper.Conversation = Backbone.Model.extend({
    database: Whisper.Database,
    storeName: 'conversations',
    defaults: function() {
      return { unreadCount : 0 };
    },

    handleMessageError: function(message, errors) {
        this.trigger('messageError', message, errors);
    },

    initialize: function() {
        this.ourNumber = textsecure.storage.user.getNumber();

        this.contactCollection = new Backbone.Collection();
        this.messageCollection = new Whisper.MessageCollection([], {
            conversation: this
        });

        this.messageCollection.on('change:errors', this.handleMessageError, this);

        this.on('change:avatar', this.updateAvatarUrl);
        this.on('destroy', this.revokeAvatarUrl);
    },

    updateVerified: function() {
        // TODO: replace this with the real call
        function checkTrustStore() {
            return Promise.resolve('default');
        }

        if (this.isPrivate()) {
            return Promise.all([
                checkTrustStore(this.id),
                this.fetch()
            ]).then(function(results) {
                var trust = results[0];
                return this.save({verified: trust});
            });
        } else {
            return this.fetchContacts().then(function() {
                return Promise.all(this.contactCollection.map(function(contact) {
                    if (contact.id !== this.myNumber) {
                        return contact.updateVerified();
                    }
                }.bind(this)));
            }.bind(this));
        }
    },

    isVerified: function() {
        if (this.isPrivate()) {
            return this.get('verified') === 'verified';
        } else {
            return this.contactCollection.every(function(contact) {
                if (contact.id === this.myNumber) {
                    return true;
                } else {
                    return contact.isVerified();
                }
            }.bind(this));
        }
    },
    isConflict: function() {
        if (this.isPrivate()) {
            var verified = this.get('verified');
            return verified !== 'verified' && verified !== 'default';
        } else {
            return Boolean(this.getConflicts().length);
        }
    },
    getConflicts: function() {
        if (this.isPrivate()) {
            return this.isConflict() ? [this] : [];
        } else {
            return this.contactCollection.filter(function(contact) {
                if (contact.id === this.myNumber) {
                    return false;
                } else {
                    return contact.isConflict();
                }
            }.bind(this));
        }
    },
    onMemberVerifiedChange: function() {
        // If the verified state of a member changes, our aggregate state changes.
        // We trigger both events to replicate the behavior of Backbone.Model.set()
        this.trigger('change:verified');
        this.trigger('change');
    },
    toggleVerified: function() {
        if (!this.isPrivate()) {
            throw new Error('You cannot verify a group conversation. ' +
                            'You must verify individual contacts.');
        }

        if (this.isVerified()) {
            this.save({verified: 'default'});
        } else {
            this.save({verified: 'verified'});
        }
    },

    addKeyChange: function(id) {
        console.log('adding key change advisory for', this.id, this.get('timestamp'));
        var timestamp = Date.now();
        var message = new Whisper.Message({
            conversationId : this.id,
            type           : 'keychange',
            sent_at        : this.get('timestamp'),
            received_at    : timestamp,
            key_changed    : id
        });
        message.save().then(this.trigger.bind(this,'newmessage', message));
    },

    onReadMessage: function(message) {
        if (this.messageCollection.get(message.id)) {
            this.messageCollection.get(message.id).fetch();
        }

        // We mark as read everything older than this message - to clean up old stuff
        //   still marked unread in the database. If the user generally doesn't read in
        //   the desktop app, so the desktop app only gets read receipts, we can very
        //   easily end up with messages never marked as read (our previous early read
        //   receipt handling, read receipts never sent because app was offline)

        // We queue it because we often get a whole lot of read receipts at once, and
        //   their markRead calls could very easily overlap given the async pull from DB.

        // Lastly, we don't send read receipts for any message marked read due to a read
        //   receipt. That's a notification explosion we don't need.
        this.queueJob(function() {
            return this.markRead(message.get('received_at'), {sendReadReceipts: false});
        }.bind(this));
    },

    getUnread: function() {
        var conversationId = this.id;
        var unreadMessages = new Whisper.MessageCollection();
        return new Promise(function(resolve) {
            return unreadMessages.fetch({
                index: {
                    // 'unread' index
                    name  : 'unread',
                    lower : [conversationId],
                    upper : [conversationId, Number.MAX_VALUE],
                }
            }).always(function() {
                resolve(unreadMessages);
            });
        });

    },

    validate: function(attributes, options) {
        var required = ['id', 'type'];
        var missing = _.filter(required, function(attr) { return !attributes[attr]; });
        if (missing.length) { return "Conversation must have " + missing; }

        if (attributes.type !== 'private' && attributes.type !== 'group') {
            return "Invalid conversation type: " + attributes.type;
        }

        var error = this.validateNumber();
        if (error) { return error; }

        this.updateTokens();
    },

    validateNumber: function() {
        if (this.isPrivate()) {
            var regionCode = storage.get('regionCode');
            var number = libphonenumber.util.parseNumber(this.id, regionCode);
            if (number.isValidNumber) {
                this.set({ id: number.e164 });
            } else {
                return number.error || "Invalid phone number";
            }
        }
    },

    updateTokens: function() {
        var tokens = [];
        var name = this.get('name');
        if (typeof name === 'string') {
            tokens.push(name.toLowerCase());
            tokens = tokens.concat(name.trim().toLowerCase().split(/[\s\-_\(\)\+]+/));
        }
        if (this.isPrivate()) {
            var regionCode = storage.get('regionCode');
            var number = libphonenumber.util.parseNumber(this.id, regionCode);
            tokens.push(
                number.nationalNumber,
                number.countryCode + number.nationalNumber
            );
        }
        this.set({tokens: tokens});
    },

    queueJob: function(callback) {
        var previous = this.pending || Promise.resolve();
        var current = this.pending = previous.then(callback, callback);

        current.then(function() {
            if (this.pending === current) {
                delete this.pending;
            }
        }.bind(this));

        return current;
    },

    sendMessage: function(body, attachments) {
        this.queueJob(function() {
            var now = Date.now();
            var message = this.messageCollection.add({
                body           : body,
                conversationId : this.id,
                type           : 'outgoing',
                attachments    : attachments,
                sent_at        : now,
                received_at    : now,
                expireTimer    : this.get('expireTimer')
            });
            if (this.isPrivate()) {
                message.set({destination: this.id});
            }
            message.save();

            this.save({
                active_at   : now,
                timestamp   : now,
                lastMessage : message.getNotificationText()
            });

            var sendFunc;
            if (this.get('type') == 'private') {
                sendFunc = textsecure.messaging.sendMessageToNumber;
            }
            else {
                sendFunc = textsecure.messaging.sendMessageToGroup;
            }
            message.send(sendFunc(this.get('id'), body, attachments, now, this.get('expireTimer')));
        }.bind(this));
    },

    updateLastMessage: function() {
        var collection = new Whisper.MessageCollection();
        return collection.fetchConversation(this.id, 1).then(function() {
            var lastMessage = collection.at(0);
            if (lastMessage) {
              this.set({
                lastMessage : lastMessage.getNotificationText(),
                timestamp   : lastMessage.get('sent_at')
              });
            } else {
              this.set({ lastMessage: '', timestamp: null });
            }
            if (this.hasChanged('lastMessage') || this.hasChanged('timestamp')) {
                this.save();
            }
        }.bind(this));
    },

    updateExpirationTimer: function(expireTimer, source, received_at) {
        if (!expireTimer) { expireTimer = null; }
        source = source || textsecure.storage.user.getNumber();
        var timestamp = received_at || Date.now();
        this.save({ expireTimer: expireTimer });
        var message = this.messageCollection.add({
            conversationId        : this.id,
            type                  : received_at ? 'incoming' : 'outgoing',
            sent_at               : timestamp,
            received_at           : timestamp,
            flags                 : textsecure.protobuf.DataMessage.Flags.EXPIRATION_TIMER_UPDATE,
            expirationTimerUpdate : {
              expireTimer    : expireTimer,
              source         : source
            }
        });
        if (this.isPrivate()) {
            message.set({destination: this.id});
        }
        message.save();
        if (message.isOutgoing()) { // outgoing update, send it to the number/group
            var sendFunc;
            if (this.get('type') == 'private') {
                sendFunc = textsecure.messaging.sendExpirationTimerUpdateToNumber;
            }
            else {
                sendFunc = textsecure.messaging.sendExpirationTimerUpdateToGroup;
            }
            message.send(sendFunc(this.get('id'), this.get('expireTimer'), message.get('sent_at')));
        }
        return message;
    },

    isSearchable: function() {
        return !this.get('left') || !!this.get('lastMessage');
    },

    endSession: function() {
        if (this.isPrivate()) {
            var now = Date.now();
            var message = this.messageCollection.create({
                conversationId : this.id,
                type           : 'outgoing',
                sent_at        : now,
                received_at    : now,
                destination    : this.id,
                flags          : textsecure.protobuf.DataMessage.Flags.END_SESSION
            });
            message.send(textsecure.messaging.closeSession(this.id, now));
        }

    },

    updateGroup: function(group_update) {
        if (this.isPrivate()) {
            throw new Error("Called update group on private conversation");
        }
        if (group_update === undefined) {
            group_update = this.pick(['name', 'avatar', 'members']);
        }
        var now = Date.now();
        var message = this.messageCollection.create({
            conversationId : this.id,
            type           : 'outgoing',
            sent_at        : now,
            received_at    : now,
            group_update   : group_update
        });
        message.send(textsecure.messaging.updateGroup(
            this.id,
            this.get('name'),
            this.get('avatar'),
            this.get('members')
        ));
    },

    leaveGroup: function() {
        var now = Date.now();
        if (this.get('type') === 'group') {
            this.save({left: true});
            var message = this.messageCollection.create({
                group_update: { left: 'You' },
                conversationId : this.id,
                type           : 'outgoing',
                sent_at        : now,
                received_at    : now
            });
            message.send(textsecure.messaging.leaveGroup(this.id));
        }
    },

    markRead: function(newestUnreadDate, options) {
        options = options || {};
        _.defaults(options, {sendReadReceipts: true});

        var conversationId = this.id;
        Whisper.Notifications.remove(Whisper.Notifications.where({
            conversationId: conversationId
        }));

        return this.getUnread().then(function(unreadMessages) {
            var oldUnread = unreadMessages.filter(function(message) {
                return message.get('received_at') <= newestUnreadDate;
            });

            var read = _.map(oldUnread, function(m) {
                if (this.messageCollection.get(m.id)) {
                    m = this.messageCollection.get(m.id);
                } else {
                    console.log('Marked a message as read in the database, but ' +
                                'it was not in messageCollection.');
                }
                m.markRead();
                return {
                    sender    : m.get('source'),
                    timestamp : m.get('sent_at')
                };
            }.bind(this));

            var unreadCount = unreadMessages.length - read.length;
            this.save({ unreadCount: unreadCount });

            if (read.length && options.sendReadReceipts) {
                console.log('Sending', read.length, 'read receipts');
                textsecure.messaging.syncReadMessages(read);
            }
        }.bind(this));
    },

    fetchMessages: function() {
        if (!this.id) { return false; }
        return this.messageCollection.fetchConversation(this.id, null, this.get('unreadCount'));
    },

    fetchContacts: function(options) {
        return new Promise(function(resolve) {
            if (this.isPrivate()) {
                this.contactCollection.reset([this]);
                resolve();
            } else {
                var promises = [];
                var members = this.get('members') || [];

                this.contactCollection.reset(
                    members.map(function(number) {
                        var c = ConversationController.create({
                            id   : number,
                            type : 'private'
                        });
                        this.listenTo(c, 'change:verified', this.onMemberVerifiedChange);
                        promises.push(new Promise(function(resolve) {
                            c.fetch().always(resolve);
                        }));
                        return c;
                    }.bind(this))
                );
                resolve(Promise.all(promises));
            }
        }.bind(this));
    },

    destroyMessages: function() {
        this.messageCollection.fetch({
            index: {
                // 'conversation' index on [conversationId, received_at]
                name  : 'conversation',
                lower : [this.id],
                upper : [this.id, Number.MAX_VALUE],
            }
        }).then(function() {
            var models = this.messageCollection.models;
            this.messageCollection.reset([]);
            _.each(models, function(message) { message.destroy(); });
            this.save({lastMessage: null, timestamp: null}); // archive
        }.bind(this));
    },

    getName: function() {
        if (this.isPrivate()) {
            return this.get('name');
        } else {
            return this.get('name') || 'Unknown group';
        }
    },

    getTitle: function() {
        if (this.isPrivate()) {
            return this.get('name') || this.getNumber();
        } else {
            return this.get('name') || 'Unknown group';
        }
    },

    getNumber: function() {
        if (!this.isPrivate()) {
            return '';
        }
        var number = this.id;
        try {
            var parsedNumber = libphonenumber.parse(number);
            var regionCode = libphonenumber.getRegionCodeForNumber(parsedNumber);
            if (regionCode === storage.get('regionCode')) {
                return libphonenumber.format(parsedNumber, libphonenumber.PhoneNumberFormat.NATIONAL);
            } else {
                return libphonenumber.format(parsedNumber, libphonenumber.PhoneNumberFormat.INTERNATIONAL);
            }
        } catch (e) {
            return number;
        }
    },

    isPrivate: function() {
        return this.get('type') === 'private';
    },

    revokeAvatarUrl: function() {
        if (this.avatarUrl) {
            URL.revokeObjectURL(this.avatarUrl);
            this.avatarUrl = null;
        }
    },

    updateAvatarUrl: function(silent) {
        this.revokeAvatarUrl();
        var avatar = this.get('avatar');
        if (avatar) {
            this.avatarUrl = URL.createObjectURL(
                new Blob([avatar.data], {type: avatar.contentType})
            );
        } else {
            this.avatarUrl = null;
        }
        if (!silent) {
            this.trigger('change');
        }
    },
    getColor: function() {
        var title = this.get('name');
        var color = this.get('color');
        if (!color) {
            if (this.isPrivate()) {
                if (title) {
                    color = COLORS[Math.abs(this.hashCode()) % 15];
                } else {
                    color = 'grey';
                }
            } else {
                color = 'default';
            }
        }
        return color;
    },
    getAvatar: function() {
        if (this.avatarUrl === undefined) {
            this.updateAvatarUrl(true);
        }

        var title = this.get('name');
        var color = this.getColor();

        if (this.avatarUrl) {
            return { url: this.avatarUrl, color: color };
        } else if (this.isPrivate()) {
            return {
                color: color,
                content: title ? title.trim()[0] : '#'
            };
        } else {
            return { url: '/images/group_default.png', color: color };
        }
    },

    getNotificationIcon: function() {
        return new Promise(function(resolve) {
            var avatar = this.getAvatar();
            if (avatar.url) {
                resolve(avatar.url);
            } else {
                resolve(new Whisper.IdenticonSVGView(avatar).getDataUrl());
            }
        }.bind(this));
    },

    notify: function(message) {
        if (!message.isIncoming()) {
            return;
        }
        if (window.isOpen() && window.isFocused()) {
            return;
        }
        window.drawAttention();
        var sender = ConversationController.create({
            id: message.get('source'), type: 'private'
        });
        var conversationId = this.id;
        sender.fetch().then(function() {
            sender.getNotificationIcon().then(function(iconUrl) {
                console.log('adding notification');
                Whisper.Notifications.add({
                    title          : sender.getTitle(),
                    message        : message.getNotificationText(),
                    iconUrl        : iconUrl,
                    imageUrl       : message.getImageUrl(),
                    conversationId : conversationId,
                    messageId      : message.id
                });
            });
        });
    },
    hashCode: function() {
        if (this.hash === undefined) {
            var string = this.getTitle() || '';
            if (string.length === 0) {
                return 0;
            }
            var hash = 0;
            for (var i = 0; i < string.length; i++) {
                hash = ((hash<<5)-hash) + string.charCodeAt(i);
                hash = hash & hash; // Convert to 32bit integer
            }

            this.hash = hash;
        }
        return this.hash;
    }
  });

  Whisper.ConversationCollection = Backbone.Collection.extend({
    database: Whisper.Database,
    storeName: 'conversations',
    model: Whisper.Conversation,

    comparator: function(m) {
      return -m.get('timestamp');
    },

    destroyAll: function () {
        return Promise.all(this.models.map(function(m) {
            return new Promise(function(resolve, reject) {
                m.destroy().then(resolve).fail(reject);
            });
        }));
    },

    search: function(query) {
        query = query.trim().toLowerCase();
        if (query.length > 0) {
            query = query.replace(/[-.\(\)]*/g,'').replace(/^\+(\d*)$/, '$1');
            var lastCharCode = query.charCodeAt(query.length - 1);
            var nextChar = String.fromCharCode(lastCharCode + 1);
            var upper = query.slice(0, -1) + nextChar;
            return new Promise(function(resolve) {
                this.fetch({
                    index: {
                        name: 'search', // 'search' index on tokens array
                        lower: query,
                        upper: upper,
                        excludeUpper: true
                    }
                }).always(resolve);
            }.bind(this));
        }
    },

    fetchAlphabetical: function() {
        return new Promise(function(resolve) {
            this.fetch({
                index: {
                    name: 'search', // 'search' index on tokens array
                },
                limit: 100
            }).always(resolve);
        }.bind(this));
    },

    fetchGroups: function(number) {
        return new Promise(function(resolve) {
            this.fetch({
                index: {
                    name: 'group',
                    only: number
                }
            }).always(resolve);
        }.bind(this));
    },

    fetchActive: function() {
        // Ensures all active conversations are included in this collection,
        // and updates their attributes, but removes nothing.
        return this.fetch({
            index: {
                name: 'inbox', // 'inbox' index on active_at
                order: 'desc'  // ORDER timestamp DESC
                // TODO pagination/infinite scroll
                // limit: 10, offset: page*10,
            },
            remove: false
        });
    }
  });

  Whisper.Conversation.COLORS = COLORS.concat(['grey', 'default']).join(' ');

  // Special collection for fetching all the groups a certain number appears in
  Whisper.GroupCollection = Backbone.Collection.extend({
    database: Whisper.Database,
    storeName: 'conversations',
    model: Whisper.Conversation,
    fetchGroups: function(number) {
        return new Promise(function(resolve) {
            this.fetch({
                index: {
                    name: 'group',
                    only: number
                }
            }).always(resolve);
        }.bind(this));
    }
  });
})();
