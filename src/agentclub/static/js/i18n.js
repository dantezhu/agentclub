/* Lightweight UI copy registry.
 *
 * The app currently ships English UI copy only. Keeping dynamic strings
 * behind t(key) avoids scattering text through business logic and leaves a
 * straightforward path for adding more locales later.
 */
(function (global) {
    "use strict";

    const messages = {
        en: {
            "common.added": "Added",
            "common.admin": "Admin",
            "common.cancel": "Cancel",
            "common.close": "Close",
            "common.confirm": "Confirm",
            "common.copy": "Copy",
            "common.copied": "Copied",
            "common.create": "Create",
            "common.creating": "Creating...",
            "common.delete": "Delete",
            "common.deleteFailed": "Delete failed",
            "common.edit": "Edit",
            "common.error": "Error",
            "common.moreActions": "More actions",
            "common.networkError": "Network error",
            "common.ok": "OK",
            "common.reset": "Reset",
            "common.save": "Save",
            "common.saveFailed": "Save failed",
            "common.saving": "Saving...",
            "common.uploadFailed": "Upload failed",

            "admin.accessRequired": "Admin access required",
            "admin.agentCreated": "Agent created",
            "admin.agentTokenHelp": "This is the connection token for the agent. Store it securely.",
            "admin.agentTokenReset": "Agent token reset",
            "admin.agentTokenResetHelp": "This is the new connection token. The previous token is now invalid. Update the agent configuration.",
            "admin.createAgent": "Create Agent",
            "admin.createFailed": "Create failed",
            "admin.deleteAgentConfirm": "Delete agent \"{name}\"?",
            "admin.displayNameRequired": "Display name is required",
            "admin.editAgent": "Edit Agent",
            "admin.emptyAgents": "No agents yet",
            "admin.enterUsername": "Enter a username",
            "admin.resetAgentToken": "Reset token",
            "admin.resetAgentTokenConfirm": "Reset token for \"{name}\"? The previous token will stop working.",
            "admin.resetTokenFailed": "Reset token failed",

            "chat.addFailed": "Add failed",
            "chat.addMember": "Add member",
            "chat.addToGroup": "Add to group",
            "chat.allUsersInGroup": "All users are already in this group",
            "chat.clearDirectMessagesConfirm": "Clear all messages in this chat? The chat will be kept.",
            "chat.clearGroupMessagesConfirm": "Clear all messages in this group? The group will be kept.",
            "chat.clearMessages": "Clear messages",
            "chat.clearMessagesFailed": "Clear messages failed",
            "chat.chatId": "Chat ID",
            "chat.chatIdHelp": "Use this chat ID with the chat type when configuring agent notifications.",
            "chat.chatInfo": "Chat information",
            "chat.copyChatIdFailed": "Could not copy chat ID",
            "chat.createdBy": "Created by <strong>{name}</strong>",
            "chat.createdOn": "Created on {date}",
            "chat.createChatFailed": "Could not create chat",
            "chat.createFailed": "Create failed",
            "chat.createGroup": "Create group",
            "chat.deleteChat": "Delete chat",
            "chat.deleteChatConfirm": "Delete this chat? The chat history will be cleared.",
            "chat.directChat": "Direct chat",
            "chat.directChats": "Direct Chats",
            "chat.dissolveFailed": "Dissolve failed",
            "chat.dissolveGroup": "Dissolve group",
            "chat.dissolveGroupConfirm": "Dissolve this group? All messages will be deleted.",
            "chat.everyone": "Everyone",
            "chat.fileAudio": "[Audio]",
            "chat.fileFile": "[File]",
            "chat.fileImage": "[Image]",
            "chat.fileVideo": "[Video]",
            "chat.group": "Group",
            "chat.groupChat": "Group chat",
            "chat.groupNameRequired": "Group name is required",
            "chat.groupSettings": "Group settings",
            "chat.groups": "Group Chats",
            "chat.leaveFailed": "Leave failed",
            "chat.leaveGroup": "Leave group",
            "chat.leaveGroupConfirm": "Leave this group?",
            "chat.loadGroupFailed": "Could not load group information",
            "chat.loadUserFailed": "Could not load user information",
            "chat.memberCount": "{count} members",
            "chat.memberCountSingular": "1 member",
            "chat.noChatsHtml": "No chats yet<br>Use the menu to start one",
            "chat.noOtherUsers": "No other users",
            "chat.offline": "Offline",
            "chat.online": "Online",
            "chat.profileInfo": "Profile information",
            "chat.removeFailed": "Remove failed",
            "chat.removeMember": "Remove member",
            "chat.removeMemberConfirm": "Remove this member?",
            "chat.sendFailed": "Message failed to send",
            "chat.startDirectChat": "Start direct chat",
            "chat.typing": "{name} is typing...",
            "chat.viewInfo": "View info",
            "chat.viewGroupInfo": "View group information",
            "chat.viewProfile": "View profile information",
            "chat.wasOnlineDate": "Last online: {date}",
            "chat.wasOnlineDay": "Last online 1 day ago",
            "chat.wasOnlineDays": "Last online {count} days ago",
            "chat.wasOnlineHour": "Last online 1 hour ago",
            "chat.wasOnlineHours": "Last online {count} hours ago",
            "chat.wasOnlineMinute": "Last online 1 minute ago",
            "chat.wasOnlineMinutes": "Last online {count} minutes ago",
            "chat.wasOnlineNow": "Online just now",

            "profile.changePassword": "Change password",
            "profile.changePasswordFailed": "Change password failed",
            "profile.passwordChanged": "Password changed",
            "profile.passwordMismatch": "New passwords do not match",
            "profile.passwordRequired": "Enter current password and new password",
            "profile.passwordTooShort": "Password must be at least 6 characters",
        },
    };

    let locale = "en";

    function interpolate(template, params) {
        if (!params) return template;
        return template.replace(/\{(\w+)\}/g, (match, key) => (
            Object.prototype.hasOwnProperty.call(params, key)
                ? String(params[key])
                : match
        ));
    }

    function t(key, params) {
        const catalog = messages[locale] || messages.en;
        const fallback = messages.en[key];
        return interpolate(catalog[key] || fallback || key, params);
    }

    function setLocale(nextLocale) {
        if (messages[nextLocale]) locale = nextLocale;
    }

    global.AgentClubI18n = {
        messages,
        get locale() { return locale; },
        setLocale,
        t,
    };
})(window);
