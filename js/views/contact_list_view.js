/*
 * vim: ts=4:sw=4:expandtab
 */
(function () {
    'use strict';
    window.Whisper = window.Whisper || {};

    // Contact list view is used in the list group members senario, as well as the NewGroupUpdate view
    Whisper.ContactListView = Whisper.ListView.extend({
        tagName: 'div',
        itemView: Whisper.View.extend({
            tagName: 'div',
            className: 'contact',
            templateName: 'contact',
            events: {
                'click': 'showIdentity'
            },
            initialize: function(options) {
                console.log('ContactListView', options);
                this.listenBack = options.listenBack;
            },
            render_attributes: function() {
                return {
                    title: this.model.getTitle(),
                    number: this.model.getNumber(),
                    avatar: this.model.getAvatar(),
                    verified: this.model.isVerified()
                };
            },
            showIdentity: function() {
                var view = new Whisper.KeyVerificationPanelView({
                    model: this.model
                });
                this.listenBack(view);
            }
        })
    });
})();
