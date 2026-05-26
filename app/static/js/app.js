let socket;
let currentUserId;
let activeChatId = null;
let activeRecipientId = null;
let selectedMsgId = null;
let selectedMsgText = null;
let selectedMsgSenderName = null;
let selectedMsgFileType = null;
let selectedMsgFilePath = null;
let selectedMsgFileName = null;
let currentReplyToId = null;
let isTypingState = false;
let typingTimeout = null;
let userStatuses = {};
let activeChatMessages = [];
let currentSharedMediaTab = 'images';

// Group and Filter variables
let activeChatFilter = 'all';
let isActiveGroup = false;
let groupOwnerId = null;
let activeGroupRole = 'member';
let activeGroupEditPermission = 'all';
let activeGroupSendPermission = 'all';


// Safe response parser that always returns an object, even if server returns HTML (e.g., 404, 500, or session revoked)
async function safeParseJson(res) {
  try {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      console.warn("Failed to parse JSON response:", text);
      if (text.trim().startsWith("<!doctype") || text.trim().startsWith("<html") || text.trim().startsWith("<!DOCTYPE")) {
        return { error: `Server returned HTML (${res.status} ${res.statusText}). It might be due to session timeout, database reset, or file limits.` };
      }
      return { error: text || `Server returned error status ${res.status}` };
    }
  } catch (err) {
    return { error: `Connection failed: ${err.message}` };
  }
}

// Settings cache
let appSettings = {
  theme: 'light',
  wallpaper: 'none',
  seenVisibility: true,
  readReceipts: true,
  soundEnabled: true
};

document.addEventListener("DOMContentLoaded", () => {
  // Parse user metadata from hidden HTML tags
  const meta = document.getElementById("user-metadata");
  if (meta) {
    currentUserId = parseInt(meta.getAttribute("data-user-id"));
    appSettings.theme = meta.getAttribute("data-theme") || 'light';
    appSettings.wallpaper = meta.getAttribute("data-wallpaper") || 'none';
    appSettings.seenVisibility = meta.getAttribute("data-seen-visibility") === "1";
    appSettings.readReceipts = meta.getAttribute("data-read-receipts") === "1";
    appSettings.soundEnabled = meta.getAttribute("data-sound") === "1";
  }

  // Initialize Socket.io connection
  initSocketConnection();

  // Apply default preferences
  applyThemePreference(appSettings.theme);
  applyWallpaperPreference(appSettings.wallpaper);
  syncSettingsUI();

  // Load first set of channels
  loadRecentChats();

  // Global click listeners to close context menus and dropdown panels
  window.addEventListener("click", (e) => {
    // Hide context menu unless clicked inside it
    const msgMenu = document.getElementById("msg-context-menu");
    if (msgMenu && !msgMenu.contains(e.target)) {
      msgMenu.classList.add("hidden");
    }

    // Hide attachments panel
    const attachPanel = document.getElementById("attachments-panel");
    const toggleAttachBtn = document.getElementById("btn-toggle-attachments");
    if (attachPanel && !attachPanel.contains(e.target) && (!toggleAttachBtn || !toggleAttachBtn.contains(e.target))) {
      attachPanel.classList.add("hidden");
    }

    // Hide emoji keyboard
    const emojiPanel = document.getElementById("emoji-keyboard-panel");
    const toggleEmojiBtn = document.getElementById("btn-toggle-emoji");
    if (emojiPanel && !emojiPanel.contains(e.target) && (!toggleEmojiBtn || !toggleEmojiBtn.contains(e.target))) {
      emojiPanel.classList.add("hidden");
    }
  });
});

// Setup WebSockets
function initSocketConnection() {
  socket = io();

  socket.on('connect', () => {
    console.log("ChatD Connected to server.");
  });

  socket.on('user_status_change', (data) => {
    // Record in global tracked list
    const timestamp = new Date().toISOString();
    userStatuses[data.user_id] = {
      is_online: data.is_online,
      last_seen: timestamp
    };

    // Update active chat headers if matched
    if (activeRecipientId === parseInt(data.user_id)) {
      const statusText = document.getElementById("active-chat-status-text");
      const badge = document.getElementById("active-chat-status-badge");
      const drawerStatus = document.getElementById("rec-drawer-status");
      const lastSeenDisplay = document.getElementById("rec-drawer-lastseen");
      
      if (data.is_online === 1) {
        if (statusText) statusText.textContent = "Online";
        if (badge) {
          badge.className = "absolute bottom-0 right-0 w-3 h-3 bg-green-500 border-2 border-white dark:border-zinc-900 rounded-full";
        }
        if (drawerStatus) {
          drawerStatus.textContent = "Online";
          drawerStatus.className = "text-[10px] inline-block font-bold px-2 py-0.5 rounded-full mt-1.5 bg-green-100 text-green-700 dark:bg-green-950/20 dark:text-green-400";
        }
      } else {
        const humanizedTime = formatHumanizedDate(parseUTCDate(timestamp));
        if (statusText) statusText.textContent = "Last seen " + humanizedTime;
        if (badge) {
          badge.className = "absolute bottom-0 right-0 w-3 h-3 bg-gray-400 border-2 border-white dark:border-zinc-900 rounded-full";
        }
        if (drawerStatus) {
          drawerStatus.textContent = "Offline";
          drawerStatus.className = "text-[10px] inline-block font-bold px-2 py-0.5 rounded-full mt-1.5 bg-gray-100 text-gray-500 dark:bg-zinc-800 dark:text-zinc-400";
        }
        if (lastSeenDisplay) {
          lastSeenDisplay.textContent = humanizedTime;
        }
      }
    }
    
    // Also update matching sidebar item dynamically without full reload
    const contactBadge = document.getElementById(`status-badge-${data.user_id}`);
    if (contactBadge) {
      contactBadge.className = `absolute right-0 bottom-0 w-3 h-3 rounded-full border-2 border-white dark:border-zinc-900 ${data.is_online === 1 ? 'bg-green-500' : 'bg-gray-400'}`;
    }
  });

  socket.on('receive_message', (msg) => {
    if (msg.chat_id === activeChatId) {
      // Avoid rendering duplicates if self-sent text triggers this event
      if (!document.getElementById(`msg-bubble-${msg.id}`)) {
        renderMessageBubble(msg);
        scrollToBottom();
      }
      
      // Update our local cache and refresh the shared files drawer
      const exists = activeChatMessages.some(m => Number(m.id) === Number(msg.id));
      if (!exists) {
        activeChatMessages.push(msg);
        populateSharedMediaDrawer(activeChatMessages);
      }
      
      // Let server confirm seen status instantly if receipts are active
      if (Number(msg.sender_id) !== Number(currentUserId)) {
        socket.emit('message_seen', { chat_id: activeChatId });
      }
    } else {
      // Unread notifications sound logic
      if (appSettings.soundEnabled && Number(msg.sender_id) !== Number(currentUserId)) {
        const ad = document.getElementById("message-sound");
        if (ad) ad.play().catch(e => console.log("Sound blocker active:", e));
      }
    }
    
    // Refresh sidebar to update last message description and counts
    loadRecentChats();
  });

  socket.on('messages_seen', (data) => {
    if (data.chat_id === activeChatId) {
      // Color all ticks to beautiful glowing cyber cyan double-checks representing seen state!
      const ticks = document.querySelectorAll(".checkmark-state");
      ticks.forEach(el => {
        el.innerHTML = `
          <svg class="w-4 h-4 text-cyan-400 dark:text-cyan-300 drop-shadow-[0_0_2.5px_rgba(6,182,212,0.75)] inline-block align-middle" fill="none" stroke="currentColor" stroke-width="2.8" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M7 12l3 3L17 8" opacity="0.85"></path>
            <path stroke-linecap="round" stroke-linejoin="round" d="M11 12l3 3L21 8"></path>
          </svg>
        `;
      });
    }
  });

  socket.on('messages_delivered', (data) => {
    if (data.chat_id === activeChatId) {
      // Transition from single gray tick to double gray ticks for any messages that haven't been seen yet!
      const ticks = document.querySelectorAll(".checkmark-state");
      ticks.forEach(el => {
        const hasCyanSeen = el.querySelector(".text-cyan-400, .text-cyan-300");
        if (!hasCyanSeen) {
          el.innerHTML = `
            <svg class="w-4 h-4 text-slate-300/90 dark:text-zinc-500/90 inline-block align-middle" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M7 12l3 3L17 8" opacity="0.65"></path>
              <path stroke-linecap="round" stroke-linejoin="round" d="M11 12l3 3L21 8"></path>
            </svg>
          `;
        }
      });
    }
  });

  socket.on('chat_list_update', (data) => {
    loadRecentChats();
  });

  socket.on('typing_status', (data) => {
    if (data.chat_id === activeChatId) {
      const typingInd = document.getElementById("typing-indicator");
      const typingActor = document.getElementById("typing-actor");
      
      if (data.is_typing) {
        if (typingActor) {
          // Find current chat opponent username
          const usernameHeader = document.getElementById("active-chat-username");
          typingActor.textContent = usernameHeader ? usernameHeader.textContent : "Contact";
        }
        if (typingInd) typingInd.classList.remove("hidden");
      } else {
        if (typingInd) typingInd.classList.add("hidden");
      }
    }
  });

  socket.on('message_deleted_everyone', (data) => {
    if (data.chat_id === activeChatId) {
      const bubbleText = document.getElementById(`msg-text-${data.message_id}`);
      if (bubbleText) {
        bubbleText.innerHTML = `<span class="italic text-slate-400 dark:text-zinc-500 select-none">This message was deleted</span>`;
        // Hide details in replying preview triggers
        const bubbleReply = document.getElementById(`msg-reply-container-${data.message_id}`);
        if (bubbleReply) bubbleReply.remove();
        
        // Disable action context indicators or attachments
        const bubbleFile = document.getElementById(`msg-file-${data.message_id}`);
        if (bubbleFile) bubbleFile.remove();
      }
      loadRecentChats();
    }
  });

  socket.on('message_deleted_self', (data) => {
    if (data.chat_id === activeChatId) {
      const bubble = document.getElementById(`msg-bubble-${data.message_id}`);
      if (bubble) bubble.remove();
      loadRecentChats();
    }
  });

  socket.on('reaction_update', (data) => {
    if (data.chat_id === activeChatId) {
      renderReactionsInContainer(data.message_id, data.reactions);
    }
  });
}

// REST: Recent Conversions list loading
async function loadRecentChats() {
  try {
    const res = await fetch('/api/chats');
    const data = await safeParseJson(res);
    
    const list = document.getElementById("chats-list");
    const emptyState = document.getElementById("chats-empty-state");
    
    if (!list) return;
    list.innerHTML = "";
    
    if (data.error || !Array.isArray(data)) {
      if (emptyState) {
        emptyState.innerHTML = `<p class="text-xs text-rose-500 font-medium">Failed to load chats: ${data.error || 'Invalid session'}</p>`;
        emptyState.classList.remove("hidden");
      }
      return;
    }
    
    // Filter chats based on tab selection
    let filteredData = data;
    if (activeChatFilter === 'chats') {
      filteredData = data.filter(c => c.is_group !== 1);
    } else if (activeChatFilter === 'groups') {
      filteredData = data.filter(c => c.is_group === 1);
    }
    
    if (filteredData.length === 0) {
      if (emptyState) {
        if (activeChatFilter === 'chats') {
          emptyState.innerHTML = `<p class="text-xs text-slate-400 italic">No direct chats found. Start one using search above!</p>`;
        } else if (activeChatFilter === 'groups') {
          emptyState.innerHTML = `<p class="text-xs text-slate-400 italic">No groups found. Create one using "👥 New Group"!</p>`;
        } else {
          emptyState.innerHTML = `<p class="text-xs text-slate-400 italic">No chats yet.</p>`;
        }
        emptyState.classList.remove("hidden");
      }
      return;
    } else {
      if (emptyState) emptyState.classList.add("hidden");
    }
    
    filteredData.forEach(chat => {
      const isActObj = chat.chat_id === activeChatId;
      const unreadCount = chat.unread_count || 0;
      const isGroup = chat.is_group === 1;
      
      let lastMsgText = "No messages yet";
      let lastMsgTime = "";
      
      if (chat.last_message) {
        const lm = chat.last_message;
        if (lm.is_deleted === 1) {
          lastMsgText = "This message was deleted";
        } else if (lm.type === 'image') {
          lastMsgText = "📷 Image Attachment";
        } else if (lm.type === 'video') {
          lastMsgText = "🎥 Video Attachment";
        } else if (lm.type === 'file') {
          lastMsgText = "📁 File Attachment";
        } else {
          // If it's group, display sender's name: "Sender: Message"
          if (isGroup && lm.sender_id && lm.sender_id !== currentUserId) {
            const senderName = lm.sender_username || "Someone";
            lastMsgText = `${senderName}: ${lm.text}`;
          } else {
            lastMsgText = lm.text;
          }
        }
        
        // Format timestamp safely
        let dateObj;
        if (typeof lm.timestamp === 'string') {
          const normalizedTimeStr = lm.timestamp.trim().replace(' ', 'T') + (lm.timestamp.endsWith('Z') || lm.timestamp.includes('+') ? '' : 'Z');
          dateObj = new Date(normalizedTimeStr);
          if (isNaN(dateObj.getTime())) {
            dateObj = new Date(lm.timestamp);
          }
        } else {
          dateObj = new Date(lm.timestamp);
        }
        lastMsgTime = formatShortTime(dateObj);
      }
      
      // Format dynamic chat/group values safely (no escaping required since we bind directly using JS closures)
      const usernameVal = isGroup ? (chat.group_name || 'Group Squad') : (chat.username || 'User');
      const avatarVal = isGroup ? (chat.group_avatar || '/static/images/default_avatar.svg') : (chat.profile_picture || '/static/images/default_avatar.svg');
      const bioVal = isGroup ? (chat.group_description || 'Group Squad Details') : (chat.bio || 'Hey there! I am using ChatD.');
      const mobileVal = isGroup ? 'Group Chat' : (chat.mobile || '');
      const isOnlineVal = isGroup ? 0 : (chat.is_online || 0);
      const lastSeenVal = isGroup ? '' : (chat.last_seen || '');
      const recipientIdVal = isGroup ? null : chat.recipient_id;
      const ownerIdVal = chat.owner_id || null;
      const lastSeenVisVal = (chat.last_seen_visibility !== undefined && chat.last_seen_visibility !== null) ? parseInt(chat.last_seen_visibility) : 1;
      
      // Store status & visibility tracking for direct message chats
      if (!isGroup && recipientIdVal) {
        userStatuses[recipientIdVal] = {
          is_online: isOnlineVal,
          last_seen: lastSeenVal,
          last_seen_visibility: lastSeenVisVal
        };
      }
      
      const itemRow = document.createElement("div");
      itemRow.className = `p-3 flex items-center gap-3 cursor-pointer hover:bg-slate-50 dark:hover:bg-zinc-800/50 transition-colors relative group ${isActObj ? 'bg-violet-50/70 dark:bg-zinc-800/80 border-l-4 border-violet-500' : ''}`;
      
      const editPermVal = chat.group_edit_permission || 'all';
      const sendPermVal = chat.group_send_permission || 'all';
      
      itemRow.addEventListener("click", () => {
        selectChat(
          chat.chat_id,
          recipientIdVal,
          usernameVal,
          avatarVal,
          isOnlineVal,
          lastSeenVal,
          bioVal,
          mobileVal,
          isGroup ? 1 : 0,
          ownerIdVal,
          editPermVal,
          sendPermVal,
          lastSeenVisVal
        );
      });
      
      // Groups do not show the online/offline dot in the corner
      itemRow.innerHTML = `
        <div class="relative shrink-0 select-none">
          <img src="${avatarVal}" alt="Avatar" class="w-11 h-11 rounded-full object-cover border border-slate-100 dark:border-zinc-800">
          ${!isGroup ? `
            <span id="status-badge-${chat.recipient_id}" class="absolute right-0 bottom-0 w-3 h-3 rounded-full border-2 border-white dark:border-zinc-900 ${chat.is_online === 1 ? 'bg-green-500' : 'bg-gray-400'}"></span>
          ` : `
            <span class="absolute -right-1 -bottom-1 text-xs bg-slate-100 dark:bg-zinc-800 border dark:border-zinc-700/60 p-0.5 rounded-full" title="Group">👥</span>
          `}
        </div>
        
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between">
            <h4 class="text-xs font-bold text-slate-800 dark:text-zinc-100 truncate">${isGroup ? chat.group_name : chat.username}</h4>
            <span class="text-[10px] text-slate-400 dark:text-zinc-500 font-medium whitespace-nowrap group-hover:-translate-x-6 max-md:group-hover:translate-x-0 transition-transform duration-200">${lastMsgTime}</span>
          </div>
          
          <div class="flex items-center justify-between mt-1 gap-2">
            <p class="text-[11px] text-slate-500 dark:text-zinc-400 truncate flex-1 font-medium">${lastMsgText}</p>
            <div class="flex items-center gap-1.5 shrink-0">
              ${unreadCount > 0 && !isActObj ? `
                <span class="bg-violet-600 text-white rounded-full text-[9px] font-bold h-4.5 min-w-[18px] px-1.5 flex items-center justify-center animate-pulse">${unreadCount}</span>
              ` : ''}
            </div>
          </div>
        </div>

        <!-- Float-hover Delete Chat Button -->
        <div class="absolute right-3 top-1/2 -translate-y-1/2 flex items-center opacity-0 max-md:opacity-75 md:group-hover:opacity-100 transition-all duration-200 scale-90 group-hover:scale-100 z-10">
          <button class="delete-chat-btn p-1.5 bg-rose-50 dark:bg-zinc-800 text-rose-500 hover:text-white dark:text-rose-400 hover:bg-rose-500 dark:hover:bg-rose-600 rounded-lg shadow-sm border border-rose-100 dark:border-zinc-700 hover:border-transparent dark:hover:border-transparent transition-all cursor-pointer" title="Delete Chat">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor" class="w-3.5 h-3.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
            </svg>
          </button>
        </div>
      `;
      
      const deleteBtn = itemRow.querySelector(".delete-chat-btn");
      if (deleteBtn) {
        deleteBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          confirmDeleteChatDirectly(chat.chat_id, isGroup ? (chat.group_name || 'Group') : (chat.username || 'Chat'));
        });
      }

      list.appendChild(itemRow);
    });
  } catch (err) {
    console.error("Failed loading chat list:", err);
  }
}

// REST: Contact Search Trigger
async function handleContactSearch() {
  const query = document.getElementById("contact-search").value.trim();
  const overlay = document.getElementById("search-results-overlay");
  const list = document.getElementById("search-contacts-list");
  const clearBtn = document.getElementById("clear-search-btn");
  
  if (!query) {
    overlay.classList.add("hidden");
    clearBtn.classList.add("hidden");
    return;
  }
  
  clearBtn.classList.remove("hidden");
  overlay.classList.remove("hidden");
  list.innerHTML = `<div class="p-5 text-center text-xs text-slate-400 italic">Searching database...</div>`;
  
  try {
    const res = await fetch(`/api/search-users?q=${encodeURIComponent(query)}`);
    const users = await safeParseJson(res);
    
    list.innerHTML = "";
    if (users.error || !Array.isArray(users)) {
      list.innerHTML = `<div class="p-5 text-center text-xs text-rose-500 font-semibold">Search failed: ${users.error || "Invalid response"}</div>`;
      return;
    }
    
    if (users.length === 0) {
      list.innerHTML = `<div class="p-5 text-center text-xs text-slate-400 italic">No users matching "${query}" found.</div>`;
      return;
    }
    
    users.forEach(user => {
      const userRow = document.createElement("div");
      userRow.className = "p-3 flex items-center gap-3 cursor-pointer hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors";
      
      userRow.addEventListener("click", () => {
        initiateNewChatWithUser(
          user.id,
          user.username,
          user.profile_picture,
          user.is_online,
          user.last_seen,
          user.bio || "",
          user.mobile
        );
      });
      
      userRow.innerHTML = `
        <img src="${user.profile_picture}" alt="Avatar" class="w-10 h-10 rounded-full object-cover">
        <div>
          <h4 class="text-xs font-bold">${user.username}</h4>
          <p class="text-[10px] text-slate-400 truncate max-w-[150px]">${user.bio || "Active User"}</p>
        </div>
      `;
      list.appendChild(userRow);
    });
  } catch (err) {
    console.error("Search failed:", err);
  }
}

function clearContactSearch() {
  document.getElementById("contact-search").value = "";
  document.getElementById("search-results-overlay").classList.add("hidden");
  document.getElementById("clear-search-btn").classList.add("hidden");
}

// Click search result to open chat
async function initiateNewChatWithUser(recipientId, username, profilePic, isOnline, lastSeen, bio, mobile) {
  clearContactSearch();
  try {
    const res = await fetch('/api/chats/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient_id: recipientId })
    });
    const result = await safeParseJson(res);
    if (result && result.chat_id) {
      selectChat(result.chat_id, recipientId, username, profilePic, isOnline, lastSeen, bio, mobile);
    } else {
      alert("Could not start chat: " + (result.error || "Unknown error"));
    }
  } catch (err) {
    console.error("Error creating chat channel:", err);
  }
}

// Click active conversation
async function selectChat(chatId, recipientId, username, profilePic, isOnline, lastSeen, bio, mobile, isGroup = 0, ownerId = null, groupEditPermission = 'all', groupSendPermission = 'all', lastSeenVisibility = 1) {
  // If moving channels, trigger room leaving
  if (activeChatId && activeChatId !== chatId) {
    socket.emit('leave_chat', { chat_id: activeChatId });
  }

  activeChatId = chatId;
  activeRecipientId = recipientId;
  isActiveGroup = isGroup === 1;
  groupOwnerId = ownerId;
  activeGroupRole = 'member'; // Default fallback
  activeGroupEditPermission = groupEditPermission;
  activeGroupSendPermission = groupSendPermission;

  // Read live status overrides from global dynamic trackers if registered (for DMs)
  if (!isActiveGroup && recipientId && userStatuses[recipientId] !== undefined) {
    isOnline = userStatuses[recipientId].is_online;
    if (userStatuses[recipientId].last_seen) {
      lastSeen = userStatuses[recipientId].last_seen;
    }
    if (userStatuses[recipientId].last_seen_visibility !== undefined) {
      lastSeenVisibility = userStatuses[recipientId].last_seen_visibility;
    }
  }

  // Show UI panels
  document.getElementById("chat-idle-state").classList.add("hidden");
  document.getElementById("chat-live-interface").classList.remove("hidden");
  
  // Mobile responsive layout toggle
  document.getElementById("sidebar").classList.add("hidden", "md:flex");
  const chatWin = document.getElementById("chat-window");
  if (chatWin) {
    chatWin.classList.remove("hidden");
    chatWin.classList.add("flex");
  }
  
  // Header details updates
  document.getElementById("active-chat-avatar").src = profilePic;
  document.getElementById("active-chat-username").textContent = username;
  
  const statusText = document.getElementById("active-chat-status-text");
  const badge = document.getElementById("active-chat-status-badge");
  
  if (isActiveGroup) {
    statusText.textContent = "Group Chat • Tap for details";
    badge.className = "hidden";
  } else {
    badge.classList.remove("hidden");
    if (isOnline === 1) {
      statusText.textContent = "Online";
      badge.className = "absolute bottom-0 right-0 w-3 h-3 bg-green-500 border-2 border-white dark:border-zinc-900 rounded-full";
    } else {
      if (parseInt(lastSeenVisibility) === 0) {
        statusText.textContent = "Last seen recently";
      } else {
        statusText.textContent = "Last seen " + formatHumanizedDate(parseUTCDate(lastSeen));
      }
      badge.className = "absolute bottom-0 right-0 w-3 h-3 bg-gray-400 border-2 border-white dark:border-zinc-900 rounded-full";
    }
  }
  
  // Update Rec Drawer
  document.getElementById("rec-drawer-avatar").src = profilePic;
  document.getElementById("rec-drawer-username").textContent = username;
  
  const drawerContactInfo = document.getElementById("rec-drawer-contact-info");
  const drawerGroupInfo = document.getElementById("rec-drawer-group-info");
  
  if (isActiveGroup) {
    if (drawerContactInfo) drawerContactInfo.classList.add("hidden");
    if (drawerGroupInfo) {
      drawerGroupInfo.classList.remove("hidden");
      document.getElementById("rec-drawer-group-desc").textContent = bio || "This group is active and fun!";
      
      // Load and update form fields
      document.getElementById("edit-group-name").value = username;
      document.getElementById("edit-group-desc").value = bio || "";
      
      // Update Whatsapp settings fields
      const editGroupEditPerm = document.getElementById("edit-group-edit-permission");
      const editGroupSendPerm = document.getElementById("edit-group-send-permission");
      if (editGroupEditPerm) editGroupEditPerm.value = groupEditPermission || 'all';
      if (editGroupSendPerm) editGroupSendPerm.value = groupSendPermission || 'all';
      
      if (typeof setSelectPermission === 'function') {
        setSelectPermission('edit', groupEditPermission || 'all');
        setSelectPermission('send', groupSendPermission || 'all');
      }
      
      const permissionsCtrl = document.getElementById("group-owner-permissions-ctrl");
      const isOwner = parseInt(ownerId) === parseInt(currentUserId);
      if (permissionsCtrl) {
        if (isOwner) {
          permissionsCtrl.classList.remove("hidden");
        } else {
          permissionsCtrl.classList.add("hidden");
        }
      }
    }
    
    // Dynamically retrieve group members with active role states
    await loadGroupMembers(chatId);
  } else {
    // Restore composer
    const composerBox = document.getElementById("chat-composer-section");
    const blockedBox = document.getElementById("chat-blocked-composer");
    if (composerBox) composerBox.classList.remove("hidden");
    if (blockedBox) blockedBox.classList.add("hidden");

    if (drawerGroupInfo) drawerGroupInfo.classList.add("hidden");
    if (drawerContactInfo) {
      drawerContactInfo.classList.remove("hidden");
      document.getElementById("rec-drawer-mobile").textContent = mobile || "+00 00000 00000";
      document.getElementById("rec-drawer-bio").textContent = bio || 'Hey there! I am using ChatD.';
    }
    
    const drawerStatus = document.getElementById("rec-drawer-status");
    if (drawerStatus) {
      if (isOnline === 1) {
        drawerStatus.textContent = "Online";
        drawerStatus.className = "text-[10px] inline-block font-bold px-2 py-0.5 rounded-full mt-1.5 bg-green-100 text-green-700 dark:bg-green-950/20 dark:text-green-400";
      } else {
        drawerStatus.textContent = "Offline";
        drawerStatus.className = "text-[10px] inline-block font-bold px-2 py-0.5 rounded-full mt-1.5 bg-gray-100 text-gray-500 dark:bg-zinc-800 dark:text-zinc-400";
      }
    }
    
    const lastSeenDisplay = document.getElementById("rec-drawer-lastseen");
    if (lastSeenDisplay) {
      lastSeenDisplay.textContent = formatHumanizedDate(parseUTCDate(lastSeen));
    }
  }

  // Clear Chat history button toggle inside Settings
  const clearChatBtn = document.getElementById("btn-clear-chat-setting");
  if (clearChatBtn) clearChatBtn.removeAttribute("disabled");

  // Join server socket room
  socket.emit('join_chat', { chat_id: chatId });
  socket.emit('message_seen', { chat_id: chatId });

  // Reset replies state
  cancelMessageReply();

  // Load message historical logs
  loadChatMessages(chatId);
  
  // Refresh conversations highlighted items
  loadRecentChats();
}

function closeActiveChat() {
  if (activeChatId) {
    socket.emit('leave_chat', { chat_id: activeChatId });
  }
  activeChatId = null;
  activeRecipientId = null;
  
  // Close details drawers
  toggleDrawer('recipient-drawer', false);
  
  document.getElementById("chat-live-interface").classList.add("hidden");
  document.getElementById("chat-idle-state").classList.remove("hidden");
  document.getElementById("sidebar").classList.remove("hidden", "md:flex");
  const chatWin = document.getElementById("chat-window");
  if (chatWin) {
    chatWin.classList.add("hidden");
    chatWin.classList.remove("flex");
  }
  
  const clearChatBtn = document.getElementById("btn-clear-chat-setting");
  if (clearChatBtn) clearChatBtn.setAttribute("disabled", "true");
}

// REST: Load Messages history
async function loadChatMessages(chatId) {
  const container = document.getElementById("chat-messages-container");
  if (!container) return;
  
  container.innerHTML = `<div class="p-5 text-center text-xs text-slate-400 italic">Decrypting channel...</div>`;
  container.removeAttribute("data-last-date");
  
  try {
    const res = await fetch(`/api/chats/${chatId}/messages`);
    const messages = await safeParseJson(res);
    
    container.innerHTML = "";
    container.removeAttribute("data-last-date");
    
    if (messages.error || !Array.isArray(messages)) {
      container.innerHTML = `
        <div class="flex-1 flex flex-col items-center justify-center p-8 text-center select-none">
          <p class="text-[11px] text-rose-500 font-semibold">⚠️ Load failed: ${messages.error || "Invalid session or database error"}</p>
        </div>
      `;
      return;
    }
    
    if (messages.length === 0) {
      container.innerHTML = `
        <div class="flex-1 flex flex-col items-center justify-center p-8 text-center select-none">
          <p class="text-[10px] text-violet-500 bg-violet-50 dark:bg-violet-950/35 border border-violet-100 dark:border-zinc-800 rounded-full px-3 py-1 font-semibold">🔒 End-to-end SQLite encrypted</p>
          <p class="text-[11px] text-slate-400 dark:text-zinc-500 mt-2">Send a message to start conversation.</p>
        </div>
      `;
      return;
    }
    
    messages.forEach(msg => {
      renderMessageBubble(msg);
    });
    
    scrollToBottom();
    populateSharedMediaDrawer(messages);
  } catch (err) {
    console.error("Failed loading chat logs:", err);
  }
}

// Media gallery inside recipient info panel
function populateSharedMediaDrawer(messages) {
  activeChatMessages = messages || [];
  
  // 1. Separate items into four active categories
  const images = getMediaItemsByCategory('images');
  const videos = getMediaItemsByCategory('videos');
  const docList = getMediaItemsByCategory('documents');
  const links = getMediaItemsByCategory('links');

  // 2. Set dynamic count badges in sidebar drawer
  const badgeImgCount = document.getElementById("drawer-count-images");
  if (badgeImgCount) badgeImgCount.textContent = images.length;

  const badgeVidCount = document.getElementById("drawer-count-videos");
  if (badgeVidCount) badgeVidCount.textContent = videos.length;

  const badgeDocCount = document.getElementById("drawer-count-documents");
  if (badgeDocCount) badgeDocCount.textContent = docList.length;

  const badgeLnkCount = document.getElementById("drawer-count-links");
  if (badgeLnkCount) badgeLnkCount.textContent = links.length;

  // 3. Render IMAGES Inline mini previews (up to 3 items)
  const imgPreviewContainer = document.getElementById("drawer-preview-images");
  if (imgPreviewContainer) {
    imgPreviewContainer.innerHTML = "";
    if (images.length === 0) {
      imgPreviewContainer.innerHTML = `<div class="col-span-3 text-[10px] text-slate-400 dark:text-zinc-500 italic py-1">No images shared</div>`;
    } else {
      images.slice(-3).reverse().forEach(m => {
        const img = document.createElement("img");
        img.src = m.file_path;
        img.alt = "Shared Photo";
        img.className = "w-full h-14 object-cover rounded-xl cursor-pointer border border-slate-150 dark:border-zinc-800 shadow-sm transition-all duration-300 hover:scale-105 hover:ring-2 hover:ring-violet-500/50 dark:hover:ring-violet-400/50 active:scale-95";
        img.onclick = () => openImageViewer(m.file_path);
        imgPreviewContainer.appendChild(img);
      });
    }
  }

  // 4. Render VIDEOS Inline mini previews (up to 3 items)
  const vidPreviewContainer = document.getElementById("drawer-preview-videos");
  if (vidPreviewContainer) {
    vidPreviewContainer.innerHTML = "";
    if (videos.length === 0) {
      vidPreviewContainer.innerHTML = `<div class="col-span-3 text-[10px] text-slate-400 dark:text-zinc-500 italic py-1">No videos shared</div>`;
    } else {
      videos.slice(-3).reverse().forEach(m => {
        const wrapper = document.createElement("div");
        wrapper.className = "w-full h-14 rounded-xl overflow-hidden cursor-pointer bg-black relative group border border-slate-150 dark:border-zinc-800 flex items-center justify-center shadow-sm transition-all duration-300 hover:scale-105 hover:ring-2 hover:ring-fuchsia-500/50 dark:hover:ring-fuchsia-400/50 active:scale-95";
        wrapper.innerHTML = `
          <video src="${m.file_path}" class="w-full h-full object-cover opacity-60 group-hover:opacity-85 transition-opacity" preload="metadata" muted></video>
          <div class="absolute inset-0 flex items-center justify-center bg-black/10 group-hover:bg-black/30 transition-all">
            <div class="w-7 h-7 bg-white/30 dark:bg-black/55 group-hover:bg-fuchsia-500 rounded-full flex items-center justify-center text-white text-[9px] font-bold shadow-md transition-all group-hover:scale-110">
              ▶
            </div>
          </div>
        `;
        wrapper.onclick = () => window.open(m.file_path, '_blank');
        vidPreviewContainer.appendChild(wrapper);
      });
    }
  }

  // 5. Render DOCUMENTS Inline mini list (up to 3 items)
  const docPreviewContainer = document.getElementById("drawer-preview-documents");
  if (docPreviewContainer) {
    docPreviewContainer.innerHTML = "";
    if (docList.length === 0) {
      docPreviewContainer.innerHTML = `<div class="text-[10px] text-slate-400 dark:text-zinc-500 italic py-1">No documents shared</div>`;
    } else {
      docList.slice(-3).reverse().forEach(m => {
        const isPdf = m.file_name.toLowerCase().endsWith('.pdf');
        const extLabel = isPdf ? 'PDF' : 'ZIP';
        const badgeClass = isPdf ? 'bg-rose-50 text-rose-605 border-rose-100/60 dark:bg-rose-950/35 dark:text-rose-400 dark:border-rose-900/40' : 'bg-amber-50 text-amber-605 border-amber-100/60 dark:bg-amber-955/35 dark:text-amber-400 dark:border-amber-900/40';
        
        const row = document.createElement("div");
        row.className = "flex items-center justify-between p-2 rounded-xl bg-slate-50/50 dark:bg-zinc-850/20 hover:bg-rose-400/[0.04] border border-slate-100/50 dark:border-zinc-800/40 hover:border-rose-200/50 transition-all duration-200 cursor-pointer shadow-[sm_0_1px_rgba(0,0,0,0.02)]";
        row.innerHTML = `
          <div class="flex items-center gap-2 min-w-0 flex-1">
            <span class="text-[8px] font-black px-1.5 py-0.5 rounded border leading-none shrink-0 ${badgeClass} shadow-sm">${extLabel}</span>
            <span class="text-[10px] font-bold text-slate-705 dark:text-zinc-300 truncate max-w-[130px]">${m.file_name}</span>
          </div>
          <a href="${m.file_path}" download="${m.file_name}" class="w-5 h-5 flex items-center justify-center rounded-md bg-white dark:bg-zinc-805 text-[10px] text-slate-450 hover:text-rose-500 dark:hover:text-rose-450 hover:bg-rose-50 font-bold shrink-0 border border-slate-100 dark:border-zinc-700 shadow-sm transition-all hover:scale-105 active:scale-95" onclick="event.stopPropagation()">📥</a>
        `;
        row.onclick = () => window.open(m.file_path, '_blank');
        docPreviewContainer.appendChild(row);
      });
    }
  }

  // 6. Render LINKS Inline mini list (up to 3 items)
  const linkPreviewContainer = document.getElementById("drawer-preview-links");
  if (linkPreviewContainer) {
    linkPreviewContainer.innerHTML = "";
    if (links.length === 0) {
      linkPreviewContainer.innerHTML = `<div class="text-[10px] text-slate-400 dark:text-zinc-500 italic py-1">No links shared</div>`;
    } else {
      links.slice(-3).reverse().forEach(linkObj => {
        const row = document.createElement("div");
        row.className = "flex items-center justify-between p-2 rounded-xl bg-slate-50/50 dark:bg-zinc-850/20 hover:bg-teal-400/[0.04] border border-slate-100/50 dark:border-zinc-800/40 hover:border-teal-200/50 transition-all duration-200 cursor-pointer shadow-[sm_0_1px_rgba(0,0,0,0.02)]";
        
        const copyBtnId = `copy-mini-btn-${linkObj.id}`;
        row.innerHTML = `
          <div class="flex items-center gap-2 min-w-0 flex-1">
            <span class="text-[10px] leading-none shrink-0 select-none bg-teal-50 dark:bg-teal-950/35 border border-teal-100 dark:border-teal-900/40 w-5 h-5 flex items-center justify-center rounded-md text-teal-600 dark:text-teal-400 shadow-sm">🔗</span>
            <span class="text-[10px] font-bold text-slate-705 dark:text-zinc-400 truncate max-w-[140px] hover:text-teal-650 transition-colors">${linkObj.url}</span>
          </div>
          <button id="${copyBtnId}" onclick="copyMediaLinkText('${linkObj.url}', '${copyBtnId}'); event.stopPropagation()" class="w-5 h-5 flex items-center justify-center rounded-md bg-white dark:bg-zinc-805 text-[10px] text-slate-450 hover:bg-teal-50 hover:text-teal-500 border border-slate-100 dark:border-zinc-700 shadow-sm transition-all hover:scale-105 active:scale-95" title="Copy Link">
            📋
          </button>
        `;
        row.onclick = () => window.open(linkObj.url.startsWith('http') ? linkObj.url : 'http://' + linkObj.url, '_blank');
        linkPreviewContainer.appendChild(row);
      });
    }
  }
}

// Open Category Media Details Modal
function openCategoryMediaModal(initialCategory = 'images') {
  const modal = document.getElementById("shared-media-modal");
  const card = document.getElementById("shared-media-modal-card");
  if (!modal || !card) return;

  // Clear search field
  const searchInput = document.getElementById("media-modal-search");
  if (searchInput) searchInput.value = "";

  // Show modal
  modal.classList.remove("hidden");
  // Trigger animations
  setTimeout(() => {
    card.classList.remove("scale-95", "opacity-0");
    card.classList.add("scale-100", "opacity-100");
  }, 10);

  // Switch to the requested tab
  switchMediaModalTab(initialCategory);
}

// Close Category Media Details Modal
function closeCategoryMediaModal() {
  const modal = document.getElementById("shared-media-modal");
  const card = document.getElementById("shared-media-modal-card");
  if (!modal || !card) return;

  card.classList.remove("scale-100", "opacity-100");
  card.classList.add("scale-95", "opacity-0");
  
  setTimeout(() => {
    modal.classList.add("hidden");
  }, 230);
}

// Switch categories inside details modal
function switchMediaModalTab(tab) {
  currentSharedMediaTab = tab;

  // Elegant active vs inactive styles configuration
  const activeClass = ["bg-violet-50", "text-violet-600", "dark:bg-violet-950/40", "dark:text-violet-400", "border-violet-100/40", "dark:border-violet-900/35"];
  const inactiveClass = ["text-slate-500", "hover:bg-slate-50", "dark:text-zinc-400", "dark:hover:bg-zinc-800", "bg-transparent"];

  const tabs = ['images', 'videos', 'documents', 'links'];
  tabs.forEach(t => {
    const btn = document.getElementById(`media-tab-${t}`);
    if (btn) {
      if (t === tab) {
        btn.classList.add(...activeClass);
        btn.classList.remove(...inactiveClass);
      } else {
        btn.classList.remove(...activeClass);
        btn.classList.add(...inactiveClass);
      }
    }
  });

  // Re-render matching resources
  renderMediaModalItems();
}

// Retrieve shared media items filter helper
function getMediaItemsByCategory(category) {
  if (!activeChatMessages) return [];

  const validMsgs = activeChatMessages.filter(m => m.is_deleted === 0);

  if (category === 'images') {
    return validMsgs.filter(m => m.type === 'image');
  } else if (category === 'videos') {
    return validMsgs.filter(m => m.type === 'video');
  } else if (category === 'documents') {
    return validMsgs.filter(m => m.type === 'file');
  } else if (category === 'links') {
    const links = [];
    const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
    validMsgs.forEach(m => {
      if (m.type === 'text' && m.text) {
        const matches = m.text.match(urlRegex);
        if (matches) {
          matches.forEach(url => {
            // Avoid adding identical links from the same message duplicate rows
            if (!links.some(l => l.url === url && l.id === m.id)) {
              links.push({
                id: m.id,
                url: url,
                sender_id: m.sender_id,
                timestamp: m.timestamp,
                text: m.text
              });
            }
          });
        }
      }
    });
    return links;
  }
  return [];
}

// Render dynamic elements inside Modal popup list
function renderMediaModalItems(filteredList = null) {
  const listContainer = document.getElementById("media-modal-list");
  if (!listContainer) return;

  listContainer.innerHTML = "";

  // Filter or grab lists
  let items = [];
  if (filteredList !== null) {
    items = filteredList;
  } else {
    items = getMediaItemsByCategory(currentSharedMediaTab);
  }

  // Update modal counts in the catalog tab header badges
  const images = getMediaItemsByCategory('images');
  const videos = getMediaItemsByCategory('videos');
  const documents = getMediaItemsByCategory('documents');
  const links = getMediaItemsByCategory('links');

  const badgeImg = document.getElementById("modal-badge-count-images");
  if (badgeImg) badgeImg.textContent = images.length;
  const badgeVid = document.getElementById("modal-badge-count-videos");
  if (badgeVid) badgeVid.textContent = videos.length;
  const badgeDoc = document.getElementById("modal-badge-count-documents");
  if (badgeDoc) badgeDoc.textContent = documents.length;
  const badgeLnk = document.getElementById("modal-badge-count-links");
  if (badgeLnk) badgeLnk.textContent = links.length;

  if (items.length === 0) {
    listContainer.innerHTML = `
      <div class="flex flex-col items-center justify-center py-16 text-center select-none animate-fade">
        <span class="text-3xl mb-2 filter drop-shadow">📂</span>
        <p class="text-xs font-bold text-slate-400 dark:text-zinc-500">No shared items found in this section</p>
      </div>
    `;
    return;
  }

  if (currentSharedMediaTab === 'images') {
    // Beautiful interactive multi-column images grid
    const grid = document.createElement("div");
    grid.className = "grid grid-cols-2 sm:grid-cols-3 gap-4 animate-fade animate-duration-300";
    
    items.forEach(m => {
      const isMe = Number(m.sender_id) === Number(currentUserId);
      const cell = document.createElement("div");
      cell.className = "group relative bg-white dark:bg-zinc-900 border border-slate-100 dark:border-zinc-800/70 p-2 rounded-2xl overflow-hidden shadow-sm hover:shadow-lg hover:border-violet-300/60 dark:hover:border-violet-900/60 transition-all duration-305 hover:-translate-y-0.5";
      cell.innerHTML = `
        <div class="relative aspect-square rounded-xl overflow-hidden bg-slate-50 dark:bg-zinc-950 shadow-inner">
          <img src="${m.file_path}" alt="Shared Image" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500">
          <div class="absolute inset-0 bg-black/45 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-all duration-200">
            <button class="px-3 py-1.5 bg-white text-slate-800 rounded-xl text-[10px] font-extrabold hover:bg-violet-600 hover:text-white shadow-xl transition-all transform hover:scale-110 active:scale-95 flex items-center gap-1" onclick="openImageViewer('${m.file_path}'); event.stopPropagation()">
              <span>🖼️</span> View
            </button>
          </div>
        </div>
        <div class="px-1 pt-2.5 flex flex-col gap-0.5 text-left">
          <span class="text-[9px] font-extrabold leading-none tracking-wide ${isMe ? 'text-violet-600 dark:text-violet-405' : 'text-slate-500 dark:text-zinc-400'}">${isMe ? 'YOU' : 'RECIPIENT'}</span>
          <span class="text-[8px] text-slate-400 dark:text-zinc-550 font-bold mt-0.5">${formatMediaTime(m.timestamp)}</span>
        </div>
      `;
      grid.appendChild(cell);
    });
    listContainer.appendChild(grid);

  } else if (currentSharedMediaTab === 'videos') {
    // Active Videos Grid
    const grid = document.createElement("div");
    grid.className = "grid grid-cols-2 sm:grid-cols-3 gap-4 animate-fade animate-duration-300";

    items.forEach(m => {
      const isMe = Number(m.sender_id) === Number(currentUserId);
      const cell = document.createElement("div");
      cell.className = "group relative bg-white dark:bg-zinc-900 border border-slate-100 dark:border-zinc-800/70 p-2 rounded-2xl overflow-hidden shadow-sm hover:shadow-lg hover:border-fuchsia-300/60 dark:hover:border-fuchsia-900/60 transition-all duration-305 hover:-translate-y-0.5";
      cell.innerHTML = `
        <div class="relative aspect-square rounded-xl overflow-hidden bg-black flex items-center justify-center shadow-inner">
          <video src="${m.file_path}" class="w-full h-full object-cover opacity-65 group-hover:opacity-85 transition-opacity duration-350" preload="metadata" muted></video>
          <button onclick="window.open('${m.file_path}', '_blank')" class="absolute w-10 h-10 bg-white/90 text-slate-800 hover:bg-fuchsia-605 hover:text-white dark:bg-zinc-805 dark:text-zinc-150 dark:hover:bg-fuchsia-500 dark:hover:text-white rounded-full transition-all duration-300 shadow-xl border border-white/20 hover:scale-110 active:scale-90 flex items-center justify-center">
            <svg class="w-4 h-4 fill-current ml-0.5" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z"/>
            </svg>
          </button>
        </div>
        <div class="px-1 pt-2.5 flex flex-col gap-0.5 text-left">
          <span class="text-[9px] font-extrabold leading-none tracking-wide ${isMe ? 'text-fuchsia-600 dark:text-fuchsia-400' : 'text-slate-500 dark:text-zinc-400'}">${isMe ? 'YOU' : 'RECIPIENT'}</span>
          <span class="text-[8px] text-slate-400 dark:text-zinc-550 font-bold mt-0.5">${formatMediaTime(m.timestamp)}</span>
        </div>
      `;
      grid.appendChild(cell);
    });
    listContainer.appendChild(grid);

  } else if (currentSharedMediaTab === 'documents') {
    // Beautiful dynamic document lists
    const list = document.createElement("div");
    list.className = "flex flex-col gap-3 animate-fade animate-duration-300";

    items.forEach(m => {
      const isMe = Number(m.sender_id) === Number(currentUserId);
      const isPdf = m.file_name.toLowerCase().endsWith('.pdf');
      const extLabel = isPdf ? 'PDF' : 'ZIP';
      const badgeClass = isPdf ? 'bg-rose-50 text-rose-600 border-rose-100 dark:bg-rose-955/35 dark:text-rose-405 dark:border-rose-900/40' : 'bg-amber-50 text-amber-605 border-amber-100 dark:bg-amber-955/35 dark:text-amber-400 dark:border-amber-900/40';

      const row = document.createElement("div");
      row.className = "bg-white dark:bg-zinc-900 border border-slate-100 dark:border-zinc-805/70 p-3.5 rounded-2xl shadow-sm hover:shadow-md flex items-center justify-between gap-3 hover:border-rose-200 dark:hover:border-zinc-700 transition-all duration-300 cursor-pointer group";
      row.innerHTML = `
        <div class="flex items-center gap-3.5 min-w-0 flex-1">
          <div class="w-11 h-11 shrink-0 border rounded-xl flex items-center justify-center font-black text-xs ${badgeClass} shadow-inner group-hover:scale-105 transition-all">
            ${extLabel}
          </div>
          <div class="min-w-0 flex-1 flex flex-col gap-0.5 text-left">
            <span class="text-xs font-bold text-slate-750 dark:text-zinc-200 truncate group-hover:text-rose-600 dark:group-hover:text-rose-400 transition-colors leading-snug">${m.file_name}</span>
            <div class="flex items-center gap-1.5 text-[9px] text-slate-400 dark:text-zinc-550 font-bold leading-none mt-1">
              <span>${isMe ? 'You' : 'Recipient'}</span>
              <span>•</span>
              <span>${formatMediaTime(m.timestamp)}</span>
            </div>
          </div>
        </div>
        <a href="${m.file_path}" download="${m.file_name}" class="p-2.5 bg-slate-55 hover:bg-rose-50 hover:text-rose-500 dark:bg-zinc-800 dark:hover:bg-zinc-700 rounded-xl transition-all font-bold shrink-0 text-slate-650 flex items-center justify-center border border-transparent hover:border-rose-100 shadow-sm hover:scale-105 active:scale-95" onclick="event.stopPropagation()">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.3" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
        </a>
      `;
      row.onclick = () => window.open(m.file_path, '_blank');
      list.appendChild(row);
    });
    listContainer.appendChild(list);

  } else if (currentSharedMediaTab === 'links') {
    // Elegant Links row list
    const list = document.createElement("div");
    list.className = "flex flex-col gap-3 animate-fade animate-duration-300";

    items.forEach(linkObj => {
      const isMe = Number(linkObj.sender_id) === Number(currentUserId);
      const row = document.createElement("div");
      row.className = "bg-white dark:bg-zinc-900 border border-slate-100 dark:border-zinc-850/70 p-3.5 rounded-2xl shadow-sm hover:shadow-md flex items-center justify-between gap-3 hover:border-teal-200 dark:hover:border-zinc-700 transition-all duration-300 cursor-pointer group";
      
      const copyBtnId = `copy-btn-modal-link-${linkObj.id}`;
      row.innerHTML = `
        <div class="flex items-center gap-3.5 min-w-0 flex-1">
          <div class="w-11 h-11 shrink-0 border border-teal-100/40 bg-teal-50/20 text-teal-600 dark:text-teal-400 rounded-xl flex items-center justify-center text-lg shadow-inner group-hover:scale-105 transition-all">
            🔗
          </div>
          <div class="min-w-0 flex-1 flex flex-col gap-0.5 text-left">
            <span class="text-xs font-black text-teal-600 dark:text-teal-400 hover:underline truncate leading-snug">
              ${linkObj.url}
            </span>
            <p class="text-[10px] text-slate-450 dark:text-zinc-500 italic truncate max-w-[280px] mt-0.5">"${linkObj.text}"</p>
            <div class="flex items-center gap-1.5 text-[9px] text-slate-400 dark:text-zinc-550 font-bold leading-none mt-1">
              <span>${isMe ? 'You' : 'Recipient'}</span>
              <span>•</span>
              <span>${formatMediaTime(linkObj.timestamp)}</span>
            </div>
          </div>
        </div>
        <button id="${copyBtnId}" onclick="copyMediaLinkText('${linkObj.url}', '${copyBtnId}'); event.stopPropagation()" class="p-2.5 bg-slate-55 hover:bg-teal-50 hover:text-teal-605 dark:bg-zinc-800 dark:hover:bg-zinc-700 rounded-xl transition-all font-bold shrink-0 text-slate-655 flex items-center justify-center border border-transparent shadow-sm hover:scale-105 active:scale-95" title="Copy URL">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
          </svg>
        </button>
      `;
      row.onclick = () => window.open(linkObj.url.startsWith('http') ? linkObj.url : 'http://' + linkObj.url, '_blank');
      list.appendChild(row);
    });
    listContainer.appendChild(list);
  }
}

// Quiet Clipboard Copier with status animation Feedback
function copyMediaLinkText(url, btnId) {
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById(btnId);
    if (btn) {
      // Rotate icon or replace visually to active checkmark state
      const originalHTML = btn.innerHTML;
      btn.innerHTML = `
        <svg class="w-4 h-4 text-green-500 animate-bounce" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      `;
      btn.classList.add("bg-green-50/50", "dark:bg-green-950/20");
      setTimeout(() => {
        btn.innerHTML = originalHTML;
        btn.classList.remove("bg-green-50/50", "dark:bg-green-950/20");
      }, 1500);
    }
  }).catch(err => {
    console.error("Link capture failed:", err);
  });
}

// Real-time keyword filter inside shared resources
function filterMediaModalItems() {
  const query = document.getElementById("media-modal-search").value.toLowerCase().trim();
  const allItems = getMediaItemsByCategory(currentSharedMediaTab);

  if (!query) {
    renderMediaModalItems(null);
    return;
  }

  let filtered = [];
  if (currentSharedMediaTab === 'images' || currentSharedMediaTab === 'videos') {
    filtered = allItems.filter(m => {
      const fn = (m.file_name || "").toLowerCase();
      const txt = (m.text || "").toLowerCase();
      return fn.includes(query) || txt.includes(query);
    });
  } else if (currentSharedMediaTab === 'documents') {
    filtered = allItems.filter(m => {
      const fn = (m.file_name || "").toLowerCase();
      return fn.includes(query);
    });
  } else if (currentSharedMediaTab === 'links') {
    filtered = allItems.filter(l => {
      const u = (l.url || "").toLowerCase();
      const t = (l.text || "").toLowerCase();
      return u.includes(query) || t.includes(query);
    });
  }

  renderMediaModalItems(filtered);
}

// Format date timestamp nicely for resource lists
function formatMediaTime(timestamp) {
  if (!timestamp) return "";
  try {
    const d = new Date(timestamp);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch (e) {
    return "";
  }
}

function getDateHeaderString(dateObj) {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  
  const dYear = dateObj.getFullYear();
  const dMonth = dateObj.getMonth();
  const dDate = dateObj.getDate();
  
  const tYear = today.getFullYear();
  const tMonth = today.getMonth();
  const tDate = today.getDate();
  
  const yYear = yesterday.getFullYear();
  const yMonth = yesterday.getMonth();
  const yDate = yesterday.getDate();
  
  if (dYear === tYear && dMonth === tMonth && dDate === tDate) {
    return "Today";
  } else if (dYear === yYear && dMonth === yMonth && dDate === yDate) {
    return "Yesterday";
  } else {
    const options = { month: 'long', day: 'numeric', year: 'numeric' };
    return dateObj.toLocaleDateString('en-US', options);
  }
}

// Dynamic bubble drawer
function renderMessageBubble(msg) {
  const container = document.getElementById("chat-messages-container");
  if (!container) return;
  
  // Avoid duplicate rendering of the same message of any type
  if (msg.id && document.getElementById(`msg-bubble-${msg.id}`)) {
    return;
  }
  
  // Clean empty state indicator
  if (container.querySelector(".select-none.p-8")) {
    container.innerHTML = "";
    container.removeAttribute("data-last-date");
  }
  
  const isMe = Number(msg.sender_id) === Number(currentUserId);
  const isSystem = msg.sender_id === null || msg.sender_id === undefined;

  // Format timestamp (with safety UTC parser)
  let dateObj;
  if (typeof msg.timestamp === 'string') {
    const normalizedTimeStr = msg.timestamp.trim().replace(' ', 'T') + (msg.timestamp.endsWith('Z') || msg.timestamp.includes('+') ? '' : 'Z');
    dateObj = new Date(normalizedTimeStr);
    if (isNaN(dateObj.getTime())) {
      dateObj = new Date(msg.timestamp);
    }
  } else {
    dateObj = new Date(msg.timestamp);
  }
  const dateStr = formatShortTime(dateObj);

  // 1. WhatsApp-style Date Separator
  const dateHeaderStr = getDateHeaderString(dateObj);
  if (!container.dataset.lastDate || container.dataset.lastDate !== dateHeaderStr) {
    const dateSeparator = document.createElement("div");
    dateSeparator.className = "flex w-full justify-center my-4 select-none";
    dateSeparator.innerHTML = `
      <span class="bg-violet-50/70 dark:bg-zinc-800 text-violet-600 dark:text-zinc-400 text-[10px] uppercase font-black tracking-wider px-3.5 py-1.5 rounded-full border border-violet-100/50 dark:border-zinc-700/50 shadow-sm leading-none">
        ${dateHeaderStr}
      </span>
    `;
    container.appendChild(dateSeparator);
    container.dataset.lastDate = dateHeaderStr;
  }

  // 2. WhatsApp-style Group System Update Message
  if (isSystem) {
    const bubbleWrapper = document.createElement("div");
    bubbleWrapper.id = `msg-bubble-${msg.id}`;
    bubbleWrapper.className = "flex w-full mb-3 justify-center select-none";
    
    // Choose appropriate icon
    let prefixEmoji = "ℹ️";
    const textLower = (msg.text || "").toLowerCase();
    if (textLower.includes("created")) {
      prefixEmoji = "👥";
    } else if (textLower.includes("added")) {
      prefixEmoji = "➕";
    } else if (textLower.includes("removed")) {
      prefixEmoji = "➖";
    } else if (textLower.includes("promoted")) {
      prefixEmoji = "⚡";
    } else if (textLower.includes("demoted")) {
      prefixEmoji = "⬇️";
    } else if (textLower.includes("left")) {
      prefixEmoji = "🚪";
    } else if (textLower.includes("updated")) {
      prefixEmoji = "🔧";
    }
    
    const sysBadge = document.createElement("div");
    sysBadge.className = "bg-slate-50/90 dark:bg-zinc-800 text-slate-500 dark:text-zinc-450 text-[10.5px] font-bold rounded-xl px-4 py-1.5 text-center shadow-sm max-w-[85%] border border-slate-200/40 dark:border-zinc-700/50 select-none flex items-center gap-1.5 justify-center leading-normal";
    sysBadge.innerHTML = `<span>${prefixEmoji}</span> <span class="font-extrabold tracking-wide">${msg.text}</span>`;
    
    bubbleWrapper.appendChild(sysBadge);
    container.appendChild(bubbleWrapper);
    return;
  }

  const bubbleWrapper = document.createElement("div");
  bubbleWrapper.id = `msg-bubble-${msg.id}`;
  bubbleWrapper.className = `flex w-full mb-2.5 ${isMe ? 'justify-end items-end' : 'justify-start items-end'}`;
  
  // Show member's DP next to their message bubble in group chat
  let avatarImg = null;
  if (isActiveGroup) {
    avatarImg = document.createElement("img");
    avatarImg.src = msg.sender_profile_picture || "/static/images/default_avatar.svg";
    avatarImg.className = "rounded-full shrink-0 mb-1 leading-none shadow-sm border border-black/5 dark:border-white/5 object-cover select-none " + (isMe ? "ml-1.5" : "mr-1.5");
    avatarImg.alt = msg.sender_username || "User";
    avatarImg.style.width = "30px";
    avatarImg.style.height = "30px";
    avatarImg.style.minWidth = "30px";
    avatarImg.style.minHeight = "30px";
    avatarImg.style.maxWidth = "30px";
    avatarImg.style.maxHeight = "30px";
    avatarImg.onerror = function() {
      this.src = "/static/images/default_avatar.svg";
    };
  }

  // Beautiful WhatsApp-style single/double-tick receipts:
  let seenCheckedIcon = '';
  if (msg.is_seen === 1 && appSettings.readReceipts) {
    seenCheckedIcon = `
      <svg class="w-4 h-4 text-cyan-400 dark:text-cyan-300 drop-shadow-[0_0_2.5px_rgba(6,182,212,0.7)] inline-block align-middle" fill="none" stroke="currentColor" stroke-width="2.8" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M7 12l3 3L17 8" opacity="0.85"></path>
        <path stroke-linecap="round" stroke-linejoin="round" d="M11 12l3 3L21 8"></path>
      </svg>
    `;
  } else if (msg.is_delivered === 2 || msg.is_seen === 1) {
    seenCheckedIcon = `
      <svg class="w-4 h-4 text-slate-300/90 dark:text-zinc-500/90 inline-block align-middle" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M7 12l3 3L17 8" opacity="0.65"></path>
        <path stroke-linecap="round" stroke-linejoin="round" d="M11 12l3 3L21 8"></path>
      </svg>
    `;
  } else {
    seenCheckedIcon = `
      <svg class="w-4 h-4 text-slate-400/80 dark:text-zinc-500/70 inline-block align-middle" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
      </svg>
    `;
  }

  // Build inside
  const bubbleBody = document.createElement("div");
  const maxWClass = isActiveGroup ? 'max-w-[68%] sm:max-w-[58%]' : 'max-w-[75%] sm:max-w-[65%]';
  bubbleBody.className = `${maxWClass} rounded-2xl px-3.5 py-1.5 flex flex-col gap-0.5 relative group text-xs font-medium min-w-0 ${
    isMe 
      ? 'bubble-3d-self msg-self' 
      : 'bubble-3d-other msg-other'
  }`;

  // Hook touch / context triggers
  bubbleBody.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openMessageContextMenu(e, msg.id, msg.text, isMe, msg.is_deleted === 1, msg.type, msg.file_path, msg.file_name);
  });

  let innerHTML = "";

  // Show member's username at top of message bubble if not self-sent in group
  if (isActiveGroup && !isMe) {
    innerHTML += `
      <div class="text-[10px] font-black text-violet-600 dark:text-violet-400 mb-0.5 leading-none tracking-wide select-none">
        ${msg.sender_username || 'Member'}
      </div>
    `;
  }

  // 1. Reply Banner if replying
  if (msg.reply_to_id) {
    innerHTML += `
      <div id="msg-reply-container-${msg.id}" class="mb-1 rounded-xl p-2 flex flex-col gap-0.5 border-l-3 border-violet-400 select-none ${
        isMe ? 'bg-violet-700/60 text-violet-100' : 'bg-slate-50 dark:bg-zinc-800/60 text-slate-500'
      }">
        <span class="text-[9px] font-bold ${isMe ? 'text-white' : 'text-violet-600'}">↩️ Reply to ${msg.reply_to_sender || 'Contact'}</span>
        <span class="text-[10px] truncate max-w-xs font-medium italic">${msg.reply_to_text}</span>
      </div>
    `;
  }

  // 2. Text or attachments
  if (msg.is_deleted === 1) {
    innerHTML += `<p id="msg-text-${msg.id}" class="italic text-slate-400 dark:text-zinc-500 select-none">This message was deleted</p>`;
  } else {
    if (msg.type === 'image') {
      innerHTML += `
        <div id="msg-file-${msg.id}" class="rounded-xl overflow-hidden cursor-pointer hover:opacity-90 max-w-sm border border-black/5 dark:border-white/5 select-none" onclick="openImageViewer('${msg.file_path}')">
          <img src="${msg.file_path}" alt="Attached Image" class="max-h-56 object-cover w-full">
        </div>
        <p id="msg-text-${msg.id}" class="mt-1 break-words break-all font-semibold">${msg.text}</p>
      `;
    } else if (msg.type === 'video') {
      innerHTML += `
        <div id="msg-file-${msg.id}" class="rounded-2xl overflow-hidden max-w-sm border border-black/10 dark:border-white/10 shadow-md bg-black relative">
          <video src="${msg.file_path}" controls class="w-full max-h-64 object-contain rounded-2xl block" preload="metadata"></video>
        </div>
        <p id="msg-text-${msg.id}" class="mt-1 break-words break-all font-semibold text-xs leading-tight">${msg.text}</p>
      `;
    } else if (msg.type === 'file') {
      const isPdf = msg.file_name.toLowerCase().endsWith('.pdf');
      const extLabel = isPdf ? 'PDF' : 'ZIP';
      innerHTML += `
        <div id="msg-file-${msg.id}" class="rounded-xl p-2.5 flex items-center justify-between gap-3 border select-none ${
          isMe ? 'bg-violet-700/40 border-violet-500/30 text-white' : 'bg-slate-50 dark:bg-zinc-800/80 border-slate-100 dark:border-zinc-800 text-slate-800 dark:text-zinc-100'
        }" onclick="window.open('${msg.file_path}', '_blank')">
          <div class="flex items-center gap-2.5 min-w-0">
            <span class="text-xl shrink-0">${isPdf ? '📄' : '📁'}</span>
            <div class="min-w-0">
              <p class="font-bold text-[10.5px] uppercase truncate max-w-[140px] md:max-w-[180px] leading-tight text-current">${msg.file_name}</p>
              <p class="text-[8px] opacity-70 mt-0.5 leading-none">Attachment Archive (${extLabel})</p>
            </div>
          </div>
          <a href="${msg.file_path}" download="${msg.file_name}" class="w-8 h-8 rounded-full flex items-center justify-center shrink-0 border transition-all duration-200 hover:scale-105 active:scale-95 shadow-sm ${
            isMe ? 'bg-white/15 hover:bg-white/25 border-white/10 text-white' : 'bg-slate-205 dark:bg-zinc-700 hover:bg-slate-300 dark:hover:bg-zinc-600 border-transparent text-slate-700 dark:text-zinc-100'
          }" onclick="event.stopPropagation()">📥</a>
        </div>
        <p id="msg-text-${msg.id}" class="mt-1 break-words break-all font-semibold hidden md:block text-[10px] italic select-none opacity-60">Attached File - ${msg.text}</p>
      `;
    } else {
      innerHTML += `<p id="msg-text-${msg.id}" class="break-words break-all leading-relaxed whitespace-pre-wrap font-semibold text-xs md:text-xs">${msg.text}</p>`;
    }
  }

  // Reactions Placeholder Container
  innerHTML += `<div id="msg-reactions-${msg.id}" class="mt-1"></div>`;

  // 3. Status footer line
  innerHTML += `
    <div class="flex items-center align-middle justify-end gap-1 text-[8.5px] font-semibold tracking-wide self-end select-none mt-0.5 opacity-70 ${isMe ? 'text-violet-100' : 'text-slate-400'}">
      <span>${dateStr}</span>
      ${isMe && msg.is_deleted === 0 ? `
        <span class="checkmark-state shrink-0">${seenCheckedIcon}</span>
      ` : ''}
    </div>
  `;

  // Mini actions contextual indicator badge on mouse hovering
  if (msg.is_deleted === 0) {
    bubbleBody.dataset.msgId = msg.id;
    bubbleBody.dataset.msgText = msg.text;
    bubbleBody.dataset.msgAuthor = isMe ? 'Me' : (msg.sender_username || document.getElementById("active-chat-username").textContent);
  }

  bubbleBody.innerHTML = innerHTML;
  
  if (isActiveGroup && avatarImg) {
    if (isMe) {
      // My message: Bubble left, avatar right
      bubbleWrapper.appendChild(bubbleBody);
      bubbleWrapper.appendChild(avatarImg);
    } else {
      // Other messages: Avatar left, bubble right
      bubbleWrapper.appendChild(avatarImg);
      bubbleWrapper.appendChild(bubbleBody);
    }
  } else {
    bubbleWrapper.appendChild(bubbleBody);
  }
  
  container.appendChild(bubbleWrapper);
  
  // Render reactions in container
  renderReactionsInContainer(msg.id, msg.reactions);
}

// REST: Send action triggering
function sendMessageAction() {
  const input = document.getElementById("chat-text-input");
  if (!input) return;
  const text = input.value.trim();
  
  if (!text || !activeChatId) return;

  // Clear typing state instantaneously
  sendTypingStatusUpdate(false);

  // Send packet
  const payload = {
    chat_id: activeChatId,
    text: text
  };

  if (currentReplyToId) {
    payload.reply_to_id = currentReplyToId;
  }

  socket.emit('send_message', payload);
  
  input.value = "";
  cancelMessageReply();
  scrollToBottom();
}

// Client seen trigger on inputs key activities
function handleTextInputChange() {
  if (!activeChatId) return;
  
  if (!isTypingState) {
    isTypingState = true;
    sendTypingStatusUpdate(true);
  }
  
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    isTypingState = false;
    sendTypingStatusUpdate(false);
  }, 2000);
}

function sendTypingStatusUpdate(isTyping) {
  if (socket && activeChatId) {
    socket.emit('typing', { chat_id: activeChatId, is_typing: isTyping });
  }
}

function handleInputKeys(e) {
  if (e.key === "Enter") {
    sendMessageAction();
  }
}

// REST: Attachment uploads
async function uploadAttachmentFile(inputElement, labelClass) {
  const file = inputElement.files[0];
  if (!file || !activeChatId) return;
  
  toggleAttachmentMenu(); // Close pane
  
  const formData = new FormData();
  formData.append('file', file);
  formData.append('chat_id', activeChatId);
  if (currentReplyToId) {
    formData.append('reply_to_id', currentReplyToId);
  }

  const container = document.getElementById("chat-messages-container");
  const tempId = `temp_${Date.now()}`;
  
  // Render loading placeholder
  const loadingDiv = document.createElement("div");
  loadingDiv.id = tempId;
  loadingDiv.className = "flex w-full mb-1 justify-end";
  loadingDiv.innerHTML = `
    <div class="bg-violet-500/60 p-3 rounded-2xl text-white font-semibold text-xs animate-pulse flex items-center gap-2">
      <span>📤 Uploading file: <b>${file.name}</b>...</span>
    </div>
  `;
  container.appendChild(loadingDiv);
  scrollToBottom();

  try {
    const res = await fetch('/api/upload-file', {
      method: 'POST',
      body: formData
    });
    
    // Remove loader
    loadingDiv.remove();
    inputElement.value = ""; // Clear file selector

    const msgResult = await safeParseJson(res);
    if (res.ok && !msgResult.error) {
      // Render clean bubble, socket emission is done automatically server-side!
      renderMessageBubble(msgResult);
      cancelMessageReply();
      scrollToBottom();
    } else {
      alert("Upload failed: " + (msgResult.error || "File size limits exceeded (16MB)."));
    }
  } catch (err) {
    loadingDiv.remove();
    console.error("Transfers error:", err);
    alert("Connection error during transport upload.");
  }
}

// Floating context menus
function openMessageContextMenu(e, msgId, text, isMe, isDeleted, fileType, filePath, fileName) {
  if (isDeleted) return; // Prevent actions on deleted messages

  selectedMsgId = msgId;
  selectedMsgText = text;
  selectedMsgFileType = fileType || null;
  selectedMsgFilePath = filePath || null;
  selectedMsgFileName = fileName || null;
  
  // Get bubble metadata sender name representation
  const bubble = document.getElementById(`msg-bubble-${msgId}`).firstElementChild;
  selectedMsgSenderName = bubble ? bubble.dataset.msgAuthor : "Contact";

  const contextMenu = document.getElementById("msg-context-menu");
  const delEveryoneBtn = document.getElementById("context-btn-delete-everyone");

  if (!contextMenu) return;

  // Toggle delete everyone availability
  if (isMe) {
    if (delEveryoneBtn) delEveryoneBtn.classList.remove("hidden");
  } else {
    if (delEveryoneBtn) delEveryoneBtn.classList.add("hidden");
  }

  contextMenu.classList.remove("hidden");
  
  // Position the menu
  const menuWidth = 192; // 48rem in CSS
  const menuHeight = isMe ? 210 : 170;
  
  let x = e.clientX;
  let y = e.clientY;

  // Viewport borders guards
  if (x + menuWidth > window.innerWidth) x -= menuWidth;
  if (y + menuHeight > window.innerHeight) y -= menuHeight;

  contextMenu.style.left = `${x}px`;
  contextMenu.style.top = `${y}px`;
}

// Actions from menu
function contextActionReply() {
  currentReplyToId = selectedMsgId;
  const preview = document.getElementById("replying-preview");
  const authorSpan = document.getElementById("reply-target-author");
  const snippetSpan = document.getElementById("reply-target-snippet");

  if (authorSpan) authorSpan.textContent = selectedMsgSenderName;
  if (snippetSpan) {
    if (selectedMsgText && selectedMsgText.startsWith('file_')) {
      snippetSpan.textContent = "📎 Attachment shared file";
    } else {
      snippetSpan.textContent = selectedMsgText;
    }
  }
  
  if (preview) preview.classList.remove("hidden");
}

function cancelMessageReply() {
  currentReplyToId = null;
  const preview = document.getElementById("replying-preview");
  if (preview) preview.classList.add("hidden");
}

function contextActionCopy() {
  if (!selectedMsgText) return;
  navigator.clipboard.writeText(selectedMsgText).then(() => {
    // Show quick feedback banner if we want or bypass
    console.log("Copied: ", selectedMsgText);
  }).catch(err => {
    console.error("Clipboard failure:", err);
  });
}

// Forward routing
async function contextActionForward() {
  const modal = document.getElementById("forward-contact-modal");
  const list = document.getElementById("forward-list-container");
  if (!modal || !list) return;

  list.innerHTML = `<div class="p-3 text-center text-xs text-slate-400 italic">Finding discussions...</div>`;
  modal.classList.remove("hidden");

  try {
    const res = await fetch('/api/chats');
    const chats = await safeParseJson(res);

    list.innerHTML = "";
    if (chats.error || !Array.isArray(chats)) {
      list.innerHTML = `<p class="p-3 text-center text-xs text-rose-500 italic">Failed to load: ${chats.error || "Server error"}</p>`;
      return;
    }

    if (chats.length === 0) {
      list.innerHTML = '<p class="p-3 text-center text-xs text-slate-405 italic">No active channels found.</p>';
      return;
    }

    chats.forEach(chat => {
      const isGroup = chat.is_group === 1;
      const displayName = isGroup ? (chat.group_name || "Group Squad") : (chat.username || "User");
      const displayAvatar = isGroup ? (chat.group_avatar || "/static/images/default_avatar.svg") : (chat.profile_picture || "/static/images/default_avatar.svg");

      const row = document.createElement("button");
      row.className = "w-full p-2.5 hover:bg-slate-55 dark:hover:bg-zinc-800/80 transition-colors flex items-center gap-2.5 text-left outline-none rounded-xl";
      row.onclick = () => forwardMessageToTargetChat(chat.chat_id, chat.recipient_id, isGroup ? 1 : 0, displayName, displayAvatar);

      row.innerHTML = `
        <img src="${displayAvatar}" class="w-8 h-8 rounded-full object-cover shrink-0 select-none border border-black/5 dark:border-white/5" onerror="this.src='/static/images/default_avatar.svg'">
        <div class="min-w-0 flex-1">
          <p class="text-xs font-extrabold truncate text-slate-800 dark:text-zinc-200">${displayName}</p>
          <p class="text-[9px] text-slate-400 dark:text-zinc-500 font-bold mt-0.5 leading-none">${isGroup ? "👥 Group Chat" : "👤 Personal Chat"}</p>
        </div>
      `;
      list.appendChild(row);
    });
  } catch (err) {
    console.error("Forwarding listing error:", err);
  }
}

function closeForwardModal() {
  document.getElementById("forward-contact-modal").classList.add("hidden");
}

function forwardMessageToTargetChat(targetChatId, recipientId, isGroup = 0, displayName = "", displayAvatar = "") {
  closeForwardModal();
  
  if (!targetChatId) return;
  if (!selectedMsgText && !selectedMsgFilePath) return;

  // Emit formatted forwarded content
  let fwdText = selectedMsgText || selectedMsgFileName || "";
  if (selectedMsgFileType === 'image' || selectedMsgFileType === 'video' || selectedMsgFileType === 'file') {
    if (fwdText && !fwdText.startsWith("↳ Forwarded message:\n\"")) {
      fwdText = `↳ Forwarded message:\n"${fwdText}"`;
    }
  } else {
    if (!fwdText.startsWith("↳ Forwarded message:\n\"")) {
      fwdText = `↳ Forwarded message:\n"${fwdText}"`;
    }
  }

  const payload = {
    chat_id: targetChatId,
    text: fwdText
  };

  if (selectedMsgFileType && selectedMsgFileType !== 'text') {
    payload.type = selectedMsgFileType;
    payload.file_path = selectedMsgFilePath;
    payload.file_name = selectedMsgFileName;
  }

  socket.emit('send_message', payload);

  // Switch workspace view automatically with correct details
  const finalAvatar = displayAvatar || '/static/images/default_avatar.svg';
  const finalName = displayName || (isGroup ? 'Group Chat' : 'User');
  selectChat(
    targetChatId, 
    isGroup ? null : recipientId, 
    finalName, 
    finalAvatar, 
    0, 
    '', 
    isGroup ? 'Group Chat details' : '', 
    isGroup ? 'Group Chat' : '', 
    isGroup ? 1 : 0
  );
}

function contextActionDelete(type) {
  if (!selectedMsgId) return;
  socket.emit('delete_message', {
    message_id: selectedMsgId,
    delete_type: type
  });
}

// Drawers Slide controls
function toggleDrawer(id, state) {
  const el = document.getElementById(id);
  if (!el) return;
  if (state) {
    el.classList.remove("translate-x-[-100%]", "translate-x-[100%]");
  } else {
    const isRight = id === "recipient-drawer";
    el.classList.add(isRight ? "translate-x-[100%]" : "translate-x-[-100%]");
  }
}

// In-app Lightbox image viewer
function openImageViewer(src) {
  const modal = document.getElementById("image-viewer-modal");
  const img = document.getElementById("image-viewer-img");
  const dl = document.getElementById("image-viewer-download");
  if (!modal || !img) return;

  img.src = src;
  if (dl) {
    dl.href = src;
    const parts = src.split("/");
    dl.download = parts[parts.length - 1] || "chatd_image.png";
  }

  modal.classList.remove("hidden");
  modal.classList.add("flex");
}

function closeImageViewer() {
  const modal = document.getElementById("image-viewer-modal");
  if (modal) {
    modal.classList.remove("flex");
    modal.classList.add("hidden");
  }
}

function toggleAttachmentMenu() {
  const panel = document.getElementById("attachments-panel");
  if (panel) panel.classList.toggle("hidden");
  
  // Cloak emojis keyboard
  const emoji = document.getElementById("emoji-keyboard-panel");
  if (emoji) emoji.classList.add("hidden");
}

function toggleEmojiPanel() {
  const panel = document.getElementById("emoji-keyboard-panel");
  if (panel) panel.classList.toggle("hidden");

  // Cloak attachments
  const attach = document.getElementById("attachments-panel");
  if (attach) attach.classList.add("hidden");
}

function insertEmojiChar(char) {
  const input = document.getElementById("chat-text-input");
  if (input) {
    input.value += char;
    input.focus();
    handleTextInputChange(); // Trigger typing status update
  }
}

// Search in Messages bar
function toggleMessageSearchSearchBar() {
  const bar = document.getElementById("message-search-bar");
  if (!bar) return;
  bar.classList.toggle("hidden");
  if (!bar.classList.contains("hidden")) {
    const input = document.getElementById("message-search-input");
    input.value = "";
    input.focus();
  } else {
    // Clear search highlights
    clearMessageSearchHighlights();
  }
}

function handleMessageSearch() {
  const query = document.getElementById("message-search-input").value.trim().toLowerCase();
  const bubbles = document.querySelectorAll("#chat-messages-container [id^='msg-text-']");
  
  clearMessageSearchHighlights();

  if (!query) return;

  bubbles.forEach(b => {
    const plainText = b.textContent.toLowerCase();
    if (plainText.includes(query)) {
      b.parentElement.classList.add("ring-2", "ring-emerald-500", "shadow-md");
      // Scroll to first highlighted match
      b.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
}

function clearMessageSearchHighlights() {
  const bubbles = document.querySelectorAll("#chat-messages-container [id^='msg-text-']");
  bubbles.forEach(b => {
    b.parentElement.classList.remove("ring-2", "ring-emerald-500", "shadow-md");
  });
}

// REST: Profile drawers update
async function handleProfileUpdate(e) {
  e.preventDefault();
  
  const form = document.getElementById("profile-edit-form");
  const formData = new FormData(form);
  
  const avatarInput = document.getElementById("profile-avatar-input");
  if (avatarInput && avatarInput.files[0]) {
    formData.append('profile_picture', avatarInput.files[0]);
  }

  try {
    const res = await fetch('/api/profile/update', {
      method: 'POST',
      body: formData
    });
    
    const data = await safeParseJson(res);
    if (res.ok && !data.error) {
      
      // Update local Display name tags
      const headerDisplay = document.getElementById("my-username-display");
      if (headerDisplay) headerDisplay.textContent = data.username;
      
      // Update global avatar display
      if (data.profile_picture) {
        document.getElementById("my-avatar-img").src = data.profile_picture;
        document.getElementById("profile-drawer-avatar").src = data.profile_picture;
      }

      alert("Profile updated successfully!");
      toggleDrawer("profile-drawer", false);
    } else {
      alert("Profile update failed: " + (data.error || "Username already taken."));
    }
  } catch (err) {
    console.error("Profile update error:", err);
  }
}

function previewAvatar(e) {
  const file = e.target.files[0];
  if (file) {
    const reader = new FileReader();
    reader.onload = function(evt) {
      document.getElementById("profile-drawer-avatar").src = evt.target.result;
    };
    reader.readAsDataURL(file);
  }
}

// REST: Theme controls & Wallpapers
function toggleThemeMode() {
  const current = appSettings.theme === 'dark' ? 'light' : 'dark';
  applyThemePreference(current);
  updateServerPreference({ theme: current });
}

function applyThemePreference(mode) {
  appSettings.theme = mode;
  const h = document.documentElement;
  const btnIcon = document.getElementById("theme-btn-icon");
  const btnText = document.getElementById("theme-btn-text");

  if (mode === 'dark') {
    h.classList.add("dark");
    if (btnIcon) btnIcon.textContent = "🌙";
    if (btnText) btnText.textContent = "Dark";
  } else {
    h.classList.remove("dark");
    if (btnIcon) btnIcon.textContent = "☀️";
    if (btnText) btnText.textContent = "Light";
  }
}

function updateWallpaperPreference(wallpaper) {
  applyWallpaperPreference(wallpaper);
  updateServerPreference({ wallpaper: wallpaper });
}

function applyWallpaperPreference(wp) {
  appSettings.wallpaper = wp;
  const container = document.getElementById("chat-messages-container");
  if (!container) return;
  
  // Remove preceding wp classes
  container.className = container.className.replace(/\bwp-\S+/g, '');
  container.classList.add(`wp-${wp}`);

  // Highlight active visual swatch buttons
  const swatches = document.querySelectorAll('#wallpaper-visual-picker .wp-swatch-btn');
  swatches.forEach(btn => {
    const val = btn.getAttribute('data-wp-val');
    if (val === wp) {
      btn.classList.add('border-violet-600', 'dark:border-violet-500', 'bg-violet-50/40', 'dark:bg-violet-950/20', 'ring-1', 'ring-violet-600/30');
      btn.classList.remove('border-slate-200', 'dark:border-zinc-800');
    } else {
      btn.classList.remove('border-violet-600', 'dark:border-violet-500', 'bg-violet-50/40', 'dark:bg-violet-950/20', 'ring-1', 'ring-violet-600/30');
      btn.classList.add('border-slate-200', 'dark:border-zinc-800');
    }
  });
}

function updatePrivacyPreference(field, value) {
  const payload = {};
  payload[field] = value;
  
  // Cache check toggle state
  if (field === 'sound_enabled') appSettings.soundEnabled = value;
  if (field === 'last_seen_visibility') appSettings.seenVisibility = value;
  if (field === 'read_receipts') appSettings.readReceipts = value;

  updateServerPreference(payload);
}

async function updateServerPreference(payload) {
  try {
    await fetch('/api/settings/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error("Failed saving preferences:", err);
  }
}

function syncSettingsUI() {
  applyWallpaperPreference(appSettings.wallpaper || 'none');

  const lastSeenCheck = document.getElementById("setting-privacy-lastseen");
  if (lastSeenCheck) lastSeenCheck.checked = appSettings.seenVisibility;

  const readCheck = document.getElementById("setting-privacy-readreceipts");
  if (readCheck) readCheck.checked = appSettings.readReceipts;

  const soundCheck = document.getElementById("setting-sound");
  if (soundCheck) soundCheck.checked = appSettings.soundEnabled;
}

// REST: Account changes
async function handleChangePassword() {
  const oldPw = document.getElementById("change-pw-old").value;
  const newPw = document.getElementById("change-pw-new").value;
  const feedback = document.getElementById("change-pw-feedback");

  if (!oldPw || !newPw) {
    showPasswordFeedback("Please enter current and new password.", "error");
    return;
  }

  try {
    const res = await fetch('/api/account/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_password: oldPw, new_password: newPw })
    });
    
    const data = await safeParseJson(res);
    if (res.ok && !data.error) {
      showPasswordFeedback("Password changed successfully!", "success");
      document.getElementById("change-pw-old").value = "";
      document.getElementById("change-pw-new").value = "";
    } else {
      showPasswordFeedback(data.error || "Verification failed.", "error");
    }
  } catch (err) {
    showPasswordFeedback("Transport connect error.", "error");
  }
}

function showPasswordFeedback(msg, style) {
  const el = document.getElementById("change-pw-feedback");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden", "bg-green-50", "text-green-700", "bg-rose-50", "text-rose-700");
  
  if (style === "success") {
    el.classList.add("bg-green-50", "text-green-700");
  } else {
    el.classList.add("bg-rose-50", "text-rose-700");
  }
  el.classList.remove("hidden");
  
  setTimeout(() => el.classList.add("hidden"), 3500);
}

// REST: Clear selected contact conversations logs
async function confirmClearSelectedChatHistory() {
  if (!activeChatId) return;
  
  const recipientName = document.getElementById("active-chat-username").textContent;
  const confirmStr = `Are you absolutely sure you want to permanently clear your chat history with ${recipientName}? This cannot be undone.`;
  
  if (confirm(confirmStr)) {
    try {
      const res = await fetch('/api/chats/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: activeChatId })
      });
      const data = await safeParseJson(res);
      if (res.ok && !data.error) {
        // Force messages reload
        loadChatMessages(activeChatId);
        loadRecentChats();
        alert("Chat history permanently removed.");
      } else {
        alert("Action failed: " + (data.error || "Unknown error"));
      }
    } catch (err) {
      console.error("Clear chat log error:", err);
    }
  }
}

// Helpers
function parseUTCDate(dateStr) {
  if (!dateStr) return new Date();
  if (typeof dateStr === 'string') {
    let clean = dateStr.trim();
    // Parse SQLite standard CURRENT_TIMESTAMP: YYYY-MM-DD HH:MM:SS
    if (clean.length === 19 && !clean.includes('T')) {
      clean = clean.replace(' ', 'T') + 'Z';
    } else if (clean.length === 19 && clean.includes('T') && !clean.endsWith('Z')) {
      clean = clean + 'Z';
    }
    const d = new Date(clean);
    if (!isNaN(d.getTime())) return d;
  }
  return new Date(dateStr);
}

function formatShortTime(date) {
  if (isNaN(date.getTime())) return "";
  let hours = date.getHours();
  let minutes = date.getMinutes();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12; // first hour is 12
  minutes = minutes < 10 ? '0'+minutes : minutes;
  return `${hours}:${minutes} ${ampm}`;
}

function formatHumanizedDate(date) {
  if (isNaN(date.getTime())) return "Recently";
  const now = new Date();
  const diffTime = Math.abs(now - date);
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0) {
    return 'Today at ' + formatShortTime(date);
  } else if (diffDays === 1) {
    return 'Yesterday at ' + formatShortTime(date);
  } else {
    return date.toLocaleDateString() + ' ' + formatShortTime(date);
  }
}

function scrollToBottom() {
  const container = document.getElementById("chat-messages-container");
  if (container) {
    setTimeout(() => {
      container.scrollTop = container.scrollHeight;
    }, 50);
  }
}

// Reactions Rendering & Interaction handlers
function renderReactionsInContainer(msgId, reactions) {
  const container = document.getElementById(`msg-reactions-${msgId}`);
  if (!container) return;
  
  if (!reactions || reactions.length === 0) {
    container.innerHTML = "";
    return;
  }
  
  const groups = {};
  reactions.forEach(r => {
    if (!groups[r.emoji]) {
      groups[r.emoji] = { count: 0, usernames: [] };
    }
    groups[r.emoji].count++;
    groups[r.emoji].usernames.push(r.username);
  });
  
  let html = `<div class="flex flex-wrap gap-1 mt-1.5 select-none">`;
  Object.keys(groups).forEach(emoji => {
    const g = groups[emoji];
    const tooltip = g.usernames.join(", ");
    const userHasReacted = reactions.some(r => Number(r.user_id) === Number(currentUserId) && r.emoji === emoji);
    
    html += `
      <div onclick="handleReactionBadgeClick(${msgId}, '${emoji}')" 
           title="${tooltip}" 
           class="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] cursor-pointer border transition-all active:scale-90 ${
             userHasReacted 
               ? 'bg-violet-100 border-violet-300 text-violet-800 dark:bg-violet-950/40 dark:border-violet-800/80 dark:text-violet-300 scale-105 shadow-sm font-bold' 
               : 'bg-slate-50 border-slate-200/60 text-slate-600 hover:bg-slate-100 dark:bg-zinc-800/90 dark:border-zinc-800 dark:text-zinc-300'
           }">
        <span>${emoji}</span>
        ${g.count > 1 ? `<span class="font-bold text-[8.5px]">${g.count}</span>` : ''}
      </div>
    `;
  });
  html += `</div>`;
  container.innerHTML = html;
}

function reactToMessage(emoji) {
  if (!selectedMsgId) return;
  socket.emit('add_reaction', { message_id: selectedMsgId, emoji: emoji });
  
  const contextMenu = document.getElementById("msg-context-menu");
  if (contextMenu) contextMenu.classList.add("hidden");
}

function handleReactionBadgeClick(msgId, emoji) {
  socket.emit('add_reaction', { message_id: msgId, emoji: emoji });
}


// --- WHATSAPP TABS FILTER ---
function setChatFilter(filter) {
  activeChatFilter = filter;
  
  // Style toggles
  const allBtn = document.getElementById("filter-all-btn");
  const chatsBtn = document.getElementById("filter-chats-btn");
  const groupsBtn = document.getElementById("filter-groups-btn");
  
  const activeClass = "px-2.5 py-1.5 rounded-full text-[11px] font-bold transition-all bg-violet-600 text-white shadow-sm duration-200";
  const inactiveClass = "px-2.5 py-1.5 rounded-full text-[11px] font-bold transition-all bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-400 hover:bg-slate-200 dark:hover:bg-zinc-700/80 duration-200";
  
  if (allBtn) allBtn.className = (filter === 'all' ? activeClass : inactiveClass);
  if (chatsBtn) chatsBtn.className = (filter === 'chats' ? activeClass : inactiveClass);
  if (groupsBtn) groupsBtn.className = (filter === 'groups' ? activeClass : inactiveClass);
  
  loadRecentChats();
}

// --- CREATE GROUP DIALOGUE MODAL ---
async function openCreateGroupModal() {
  const modal = document.getElementById("create-group-modal");
  if (!modal) return;
  
  modal.classList.remove("hidden");
  
  const listContainer = document.getElementById("create-group-contacts-list");
  if (!listContainer) return;
  
  listContainer.innerHTML = `<div class="text-[11px] text-slate-400 italic text-center py-4">Fetching users directory...</div>`;
  
  try {
    const res = await fetch('/api/search-users?only_chatted=true');
    const users = await safeParseJson(res);
    
    listContainer.innerHTML = "";
    if (users.error || !Array.isArray(users)) {
      listContainer.innerHTML = `<div class="text-[11px] text-rose-500 font-semibold text-center py-4">Failed to load directory.</div>`;
      return;
    }
    
    if (users.length === 0) {
      listContainer.innerHTML = `<div class="text-[11px] text-slate-405 italic text-center py-4">No other users in platform to invite yet.</div>`;
      return;
    }
    
    users.forEach(u => {
      const row = document.createElement("label");
      row.className = "flex items-center justify-between p-2 rounded-xl hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer select-none transition-colors border border-transparent hover:border-slate-200/40";
      row.innerHTML = `
        <div class="flex items-center gap-2.5 min-w-0">
          <img src="${u.profile_picture || '/static/images/default_avatar.svg'}" class="w-8 h-8 rounded-full object-cover shrink-0">
          <div class="min-w-0">
            <h5 class="text-xs font-bold text-slate-800 dark:text-zinc-200 truncate">${u.username}</h5>
            <p class="text-[9px] text-slate-400 truncate">${u.bio || "Active User"}</p>
          </div>
        </div>
        <input type="checkbox" name="group-members-check" value="${u.id}" class="w-4 h-4 text-violet-600 border-slate-300 rounded focus:ring-violet-500 scale-105 shrink-0">
      `;
      listContainer.appendChild(row);
    });
  } catch (err) {
    console.error("Failed load group creation roster:", err);
  }
}

function closeCreateGroupModal() {
  const modal = document.getElementById("create-group-modal");
  if (modal) {
    modal.classList.add("hidden");
  }
  
  // Clear modal fields
  const nameField = document.getElementById("new-group-name");
  const descField = document.getElementById("new-group-desc");
  if (nameField) nameField.value = "";
  if (descField) descField.value = "";
}

async function submitCreateGroup() {
  const groupName = document.getElementById("new-group-name").value.trim();
  const groupDesc = document.getElementById("new-group-desc").value.trim();
  
  if (!groupName) {
    alert("Group Name is required!");
    return;
  }
  
  // Get all checked user IDs
  const checkedBoxes = document.querySelectorAll('input[name="group-members-check"]:checked');
  const recipientIds = Array.from(checkedBoxes).map(cb => parseInt(cb.value));
  
  try {
    const res = await fetch('/api/groups/create', {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        group_name: groupName,
        group_description: groupDesc,
        recipient_ids: recipientIds
      })
    });
    
    const result = await safeParseJson(res);
    if (result && result.success) {
      closeCreateGroupModal();
      
      // Auto-select the newly created group!
      const escName = groupName.replace(/'/g, "\\'");
      const escDesc = groupDesc.replace(/'/g, "\\'");
      selectChat(result.chat_id, null, escName, '/static/images/default_avatar.svg', 0, '', escDesc, 'Group Chat', 1, currentUserId);
      
      // Highlight on list too
      loadRecentChats();
    } else {
      alert("Error: " + (result.error || "Cannot create group link"));
    }
  } catch (err) {
    console.error("Group creation fail:", err);
    alert("Create request failed.");
  }
}

// --- LOAD GROUP ROSTERS & ACTION RIGHTS ---
async function loadGroupMembers(chatId) {
  const membersList = document.getElementById("group-members-list");
  const memberCountBadge = document.getElementById("group-member-count");
  if (!membersList) return;
  
  membersList.innerHTML = `<div class="text-[10px] text-slate-400 italic py-2">Loading squad members...</div>`;
  
  try {
    const res = await fetch(`/api/groups/${chatId}/members`);
    const members = await safeParseJson(res);
    
    if (members.error || !Array.isArray(members)) {
      membersList.innerHTML = `<div class="text-[10px] text-rose-500 font-semibold py-2">Unauthorized. You were removed or left.</div>`;
      if (memberCountBadge) memberCountBadge.textContent = "0";
      return;
    }
    
    if (memberCountBadge) memberCountBadge.textContent = members.length;
    
    // Find my role in the list
    const myMe = members.find(m => parseInt(m.id) === parseInt(currentUserId));
    activeGroupRole = myMe ? myMe.role : 'member';
    
    // Toggle Admin Panel items inside recipient sidebar drawer
    const adminSettingsSection = document.getElementById("group-admin-settings-section");
    const adminAddSection = document.getElementById("group-admin-add-section");
    const permissionsCtrl = document.getElementById("group-owner-permissions-ctrl");
    
    if (typeof setSelectPermission === 'function') {
      setSelectPermission('edit', activeGroupEditPermission || 'all');
      setSelectPermission('send', activeGroupSendPermission || 'all');
    }
    
    // Who can see the group settings panel?
    // Normal members (who are not admins) cannot change group information or settings
    const canEditDetails = (activeGroupRole === 'owner' || activeGroupRole === 'admin');
    if (adminSettingsSection) {
      if (canEditDetails) {
        adminSettingsSection.classList.remove("hidden");
      } else {
        adminSettingsSection.classList.add("hidden");
      }
    }
    
    // Who can modify group access permissions? Only the Group Creator/Owner!
    if (permissionsCtrl) {
      if (activeGroupRole === 'owner') {
        permissionsCtrl.classList.remove("hidden");
      } else {
        permissionsCtrl.classList.add("hidden");
      }
    }
    
    // Who can add members? Standard admins or group owner can add members
    const isBoss = activeGroupRole === 'owner' || activeGroupRole === 'admin';
    if (adminAddSection) {
      if (isBoss) {
        adminAddSection.classList.remove("hidden");
      } else {
        adminAddSection.classList.add("hidden");
      }
    }
    
    // Check messaging composer permission block
    const isMessageAllowed = !isActiveGroup || (activeGroupSendPermission === 'all') || (activeGroupRole === 'owner' || activeGroupRole === 'admin');
    const composerBox = document.getElementById("chat-composer-section");
    const blockedBox = document.getElementById("chat-blocked-composer");
    if (isMessageAllowed) {
      if (composerBox) composerBox.classList.remove("hidden");
      if (blockedBox) blockedBox.classList.add("hidden");
    } else {
      if (composerBox) composerBox.classList.add("hidden");
      if (blockedBox) blockedBox.classList.remove("hidden");
    }

    membersList.innerHTML = "";
    members.forEach(m => {
      const isSelf = parseInt(m.id) === parseInt(currentUserId);
      
      // Render member card row element
      const mRow = document.createElement("div");
      mRow.className = "flex items-center justify-between p-1.5 rounded-xl hover:bg-slate-100/50 dark:hover:bg-zinc-800/40 gap-1 transition-colors";
      
      // Check and render roles labels with validated classes
      let roleLabel = "";
      if (m.role === 'owner') {
        roleLabel = `<span class="text-[8px] uppercase tracking-wider bg-rose-50 dark:bg-rose-950/20 px-1.5 py-0.5 rounded font-black text-rose-500 border border-rose-200/40 dark:border-rose-900/40 shrink-0">Owner</span>`;
      } else if (m.role === 'admin') {
        roleLabel = `<span class="text-[8px] uppercase tracking-wider bg-purple-50 dark:bg-purple-950/20 px-1.5 py-0.5 rounded font-black text-purple-500 border border-purple-200/40 dark:border-purple-900/40 shrink-0">Admin</span>`;
      }
      
      // Construct action items based on permission rankings of owner vs admin
      let actionButtons = "";
      if (!isSelf) {
        if (activeGroupRole === 'owner') {
          // Owner has full power
          if (m.role === 'admin') {
            actionButtons += `
              <button onclick="demoteGroupMember(${m.id})" title="Demote to Member" class="text-[9px] font-extrabold text-amber-500 hover:text-amber-600 bg-amber-50 dark:bg-amber-950/20 border border-amber-200/30 px-1.5 py-0.5 rounded transition-colors cursor-pointer">
                Demote
              </button>
            `;
          } else {
            actionButtons += `
              <button onclick="promoteGroupMember(${m.id})" title="Promote to Admin" class="text-[9px] font-extrabold text-violet-500 hover:text-violet-600 bg-violet-50 dark:bg-violet-950/20 border border-violet-200/30 px-1.5 py-0.5 rounded transition-colors cursor-pointer">
                Promote
              </button>
            `;
          }
          // Owner can remove standard member or admin
          actionButtons += `
            <button onclick="removeGroupMember(${m.id})" title="Remove Member" class="text-[9px] font-extrabold text-rose-500 hover:text-rose-600 bg-rose-50 dark:bg-rose-950/20 border border-rose-200/30 px-1.5 py-0.5 rounded ml-1 transition-colors cursor-pointer">
              Remove
            </button>
          `;
        } else if (activeGroupRole === 'admin') {
          // Admins can remove standard members, but cannot touch owners or elevate others to admins
          if (m.role === 'member') {
            actionButtons += `
              <button onclick="removeGroupMember(${m.id})" title="Remove Member" class="text-[9px] font-extrabold text-rose-500 hover:text-rose-600 bg-rose-50 dark:bg-rose-950/20 border border-rose-200/30 px-1.5 py-0.5 rounded-lg transition-colors cursor-pointer">
                Remove
              </button>
            `;
          }
        }
      }
      
      mRow.innerHTML = `
        <div class="flex items-center gap-2 min-w-0">
          <img src="${m.profile_picture || '/static/images/default_avatar.svg'}" class="w-8 h-8 rounded-full object-cover shrink-0 border border-slate-100 dark:border-zinc-805">
          <div class="min-w-0">
            <h5 class="text-xs font-semibold text-slate-850 dark:text-zinc-200 truncate flex items-center gap-1.5">
              <span class="truncate max-w-[80px]">${m.username}</span>
              ${roleLabel}
            </h5>
            <p class="text-[9.5px] text-slate-400 dark:text-zinc-500 truncate mt-0.5">${isSelf ? '<span class="italic font-medium text-slate-500">You</span>' : (m.bio || 'Hey there!')}</p>
          </div>
        </div>
        
        <div class="shrink-0 flex items-center">
          ${actionButtons}
        </div>
      `;
      membersList.appendChild(mRow);
    });
    
    // Re-fill add members custom drop-down list
    const customList = document.getElementById("custom-add-member-list");
    const valInput = document.getElementById("group-add-member-select-value");
    const selectedText = document.getElementById("custom-add-member-selected-text");
    const searchInput = document.getElementById("custom-add-member-search");
    
    if (customList) {
      customList.innerHTML = `<div class="text-[10px] text-slate-400 dark:text-zinc-500 p-2.5 italic text-center font-semibold">Loading users...</div>`;
      if (valInput) valInput.value = "";
      if (selectedText) selectedText.textContent = "Select user...";
      if (searchInput) searchInput.value = "";
      
      const usersRes = await fetch('/api/search-users?only_chatted=true');
      const allUsers = await safeParseJson(usersRes);
      
      customList.innerHTML = "";
      if (Array.isArray(allUsers)) {
        // Filter out users who are already in group
        const eligible = allUsers.filter(u => !members.some(m => parseInt(m.id) === parseInt(u.id)));
        
        if (eligible.length === 0) {
          customList.innerHTML = `<div class="text-[10px] text-slate-400 dark:text-zinc-500 p-2.5 italic text-center font-semibold">No other eligible users</div>`;
        } else {
          eligible.forEach(el => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "custom-member-item w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-violet-50/70 dark:hover:bg-zinc-900/60 transition-all text-left cursor-pointer";
            btn.setAttribute("data-username", el.username.toLowerCase());
            
            // Build simple click handler
            btn.onclick = () => {
              selectCustomAddMember(el.id, el.username, el.profile_picture || '/static/images/default_avatar.svg');
            };
            
            btn.innerHTML = `
              <img src="${el.profile_picture || '/static/images/default_avatar.svg'}" class="w-5 h-5 rounded-full object-cover shrink-0 border border-slate-100 dark:border-zinc-800">
              <span class="text-xs font-bold text-slate-700 dark:text-zinc-200 truncate">${el.username}</span>
            `;
            customList.appendChild(btn);
          });
        }
      } else {
        customList.innerHTML = `<div class="text-[10px] text-rose-500 dark:text-rose-400 p-2.5 italic text-center font-semibold">Failed to load users</div>`;
      }
    }
  } catch (err) {
    console.error("Group members load failed:", err);
  }
}

// --- VISUAL DRILL-DOWN CUSTOM HELPERS ---

function setSelectPermission(type, value) {
  const input = document.getElementById(`edit-group-${type}-permission`);
  if (input) {
    input.value = value || 'all';
  }

  const btnAll = document.getElementById(`btn-${type}-all`);
  const btnAdmins = document.getElementById(`btn-${type}-admins`);

  if (!btnAll || !btnAdmins) return;

  if (value === 'admins') {
    // Only Admins active
    btnAll.className = "flex-1 py-1.5 text-xs rounded-lg transition-all text-center focus:outline-none flex items-center justify-center gap-1 text-slate-500 hover:text-slate-700 dark:text-zinc-400 dark:hover:text-zinc-200 bg-transparent border-transparent font-semibold cursor-pointer select-none";
    btnAdmins.className = "flex-1 py-1.5 text-xs rounded-lg transition-all text-center focus:outline-none flex items-center justify-center gap-1 bg-white dark:bg-zinc-800 text-violet-600 dark:text-violet-400 border border-slate-200/50 dark:border-zinc-700/50 shadow-sm font-extrabold cursor-pointer select-none";
  } else {
    // All members active
    btnAll.className = "flex-1 py-1.5 text-xs rounded-lg transition-all text-center focus:outline-none flex items-center justify-center gap-1 bg-white dark:bg-zinc-800 text-violet-600 dark:text-violet-400 border border-slate-200/50 dark:border-zinc-700/50 shadow-sm font-extrabold cursor-pointer select-none";
    btnAdmins.className = "flex-1 py-1.5 text-xs rounded-lg transition-all text-center focus:outline-none flex items-center justify-center gap-1 text-slate-500 hover:text-slate-700 dark:text-zinc-400 dark:hover:text-zinc-200 bg-transparent border-transparent font-semibold cursor-pointer select-none";
  }
}

function toggleCustomAddMemberDropdown() {
  const menu = document.getElementById("custom-add-member-menu");
  if (menu) {
    menu.classList.toggle("hidden");
    if (!menu.classList.contains("hidden")) {
      const searchInput = document.getElementById("custom-add-member-search");
      if (searchInput) {
        searchInput.value = "";
        searchInput.focus();
      }
      filterCustomAddMemberDropdown();
    }
  }
}

function filterCustomAddMemberDropdown() {
  const qObj = document.getElementById("custom-add-member-search");
  const query = (qObj ? qObj.value : "").toLowerCase().trim();
  const items = document.querySelectorAll(".custom-member-item");
  items.forEach(item => {
    const name = (item.getAttribute("data-username") || "");
    if (name.includes(query)) {
      item.classList.remove("hidden");
    } else {
      item.classList.add("hidden");
    }
  });
}

function selectCustomAddMember(userId, username, avatarUrl) {
  const input = document.getElementById("group-add-member-select-value");
  const textSpan = document.getElementById("custom-add-member-selected-text");
  const menu = document.getElementById("custom-add-member-menu");
  
  if (input) input.value = userId;
  if (textSpan) {
    textSpan.innerHTML = `
      <div class="flex items-center gap-1.5 truncate">
        <img src="${avatarUrl}" class="w-4 h-4 rounded-full object-cover shrink-0">
        <span class="text-xs font-bold text-slate-700 dark:text-zinc-200 truncate">${username}</span>
      </div>
    `;
  }
  if (menu) menu.classList.add("hidden");
}

// Global listener to close add members dropdown on outside clicks
document.addEventListener("click", (e) => {
  const menu = document.getElementById("custom-add-member-menu");
  const ctr = document.getElementById("custom-add-member-dropdown-container");
  if (menu && ctr && !ctr.contains(e.target)) {
    menu.classList.add("hidden");
  }
});

// --- GROUP SETTINGS CRUDS ---
async function saveGroupSettings() {
  const nameField = document.getElementById("edit-group-name");
  const descField = document.getElementById("edit-group-desc");
  const avatarFileField = document.getElementById("edit-group-avatar");
  
  const gName = nameField.value.trim();
  const gDesc = descField.value.trim();
  
  if (!gName) {
    alert("Group Name cannot be empty!");
    return;
  }
  
  const formData = new FormData();
  formData.append("group_name", gName);
  formData.append("group_description", gDesc);
  
  const editGroupEditPerm = document.getElementById("edit-group-edit-permission");
  const editGroupSendPerm = document.getElementById("edit-group-send-permission");
  if (editGroupEditPerm) {
    formData.append("group_edit_permission", editGroupEditPerm.value);
  }
  if (editGroupSendPerm) {
    formData.append("group_send_permission", editGroupSendPerm.value);
  }
  
  if (avatarFileField && avatarFileField.files[0]) {
    formData.append("group_avatar", avatarFileField.files[0]);
  }
  
  try {
    const res = await fetch(`/api/groups/${activeChatId}/settings`, {
      method: "POST",
      body: formData
    });
    const result = await safeParseJson(res);
    
    if (result && result.success) {
      alert("Group details saved!");
      
      // Update screen headers
      document.getElementById("active-chat-username").textContent = result.group_name;
      document.getElementById("rec-drawer-username").textContent = result.group_name;
      document.getElementById("rec-drawer-group-desc").textContent = result.group_description;
      
      if (result.group_edit_permission) activeGroupEditPermission = result.group_edit_permission;
      if (result.group_send_permission) activeGroupSendPermission = result.group_send_permission;
      
      if (result.group_avatar) {
        document.getElementById("active-chat-avatar").src = result.group_avatar;
        document.getElementById("rec-drawer-avatar").src = result.group_avatar;
      }
      
      // Clear avatar input file element
      if (avatarFileField) avatarFileField.value = "";
      
      loadRecentChats();
      loadGroupMembers(activeChatId);
    } else {
      alert("Error: " + (result.error || "Cannot save. Unauthorized."));
    }
  } catch (err) {
    console.error("Save group meta setting fail:", err);
    alert("Failed requesting save.");
  }
}

async function addGroupMember() {
  const selectBox = document.getElementById("group-add-member-select-value");
  const targetId = selectBox ? selectBox.value : "";
  
  if (!targetId) {
    alert("Please select a user to add.");
    return;
  }
  
  try {
    const res = await fetch(`/api/groups/${activeChatId}/members/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_ids: [parseInt(targetId)] })
    });
    const result = await safeParseJson(res);
    
    if (result && result.success) {
      loadGroupMembers(activeChatId);
      loadRecentChats();
    } else {
      alert("Error adding member: " + (result.error || "Unknown error"));
    }
  } catch (err) {
    console.error("Add group member error:", err);
  }
}

function removeGroupMember(uId) {
  showConfirmModal({
    title: "Remove Member",
    message: "Are you sure you want to remove this member from the group?",
    confirmText: "Remove Member",
    type: "danger",
    icon: "👤",
    onConfirm: async () => {
      try {
        const res = await fetch(`/api/groups/${activeChatId}/members/remove`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: parseInt(uId) })
        });
        const result = await safeParseJson(res);
        
        if (result && result.success) {
          loadGroupMembers(activeChatId);
          loadRecentChats();
        } else {
          alert("Error removing member: " + (result.error || "Permission denied"));
        }
      } catch (err) {
        console.error("Remove member err:", err);
      }
    }
  });
}

function promoteGroupMember(uId) {
  showConfirmModal({
    title: "Promote Member",
    message: "Are you sure you want to promote this member to group Admin?",
    confirmText: "Promote to Admin",
    type: "info",
    icon: "⚡",
    onConfirm: async () => {
      try {
        const res = await fetch(`/api/groups/${activeChatId}/members/promote`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: parseInt(uId) })
        });
        const result = await safeParseJson(res);
        
        if (result && result.success) {
          loadGroupMembers(activeChatId);
        } else {
          alert("Error promoting: " + (result.error || "Permission denied"));
        }
      } catch (err) {
        console.error("Promote admin err:", err);
      }
    }
  });
}

function demoteGroupMember(uId) {
  showConfirmModal({
    title: "Demote Admin",
    message: "Demote this Admin back to regular Member?",
    confirmText: "Demote Admin",
    type: "warning",
    icon: "⬇️",
    onConfirm: async () => {
      try {
        const res = await fetch(`/api/groups/${activeChatId}/members/demote`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: parseInt(uId) })
        });
        const result = await safeParseJson(res);
        
        if (result && result.success) {
          loadGroupMembers(activeChatId);
        } else {
          alert("Error demoting: " + (result.error || "Only owners can demote admins."));
        }
      } catch (err) {
        console.error("Demote request fail:", err);
      }
    }
  });
}

function leaveGroup() {
  showConfirmModal({
    title: "Leave Group Chat",
    message: "Do you really want to leave this group chat?",
    confirmText: "Yes, Leave Group",
    type: "danger",
    icon: "🚪",
    onConfirm: async () => {
      try {
        const res = await fetch(`/api/groups/${activeChatId}/leave`, {
          method: "POST"
        });
        const result = await safeParseJson(res);
        
        if (result && result.success) {
          closeActiveChat();
          loadRecentChats();
        } else {
          alert("Error leaving group: " + (result.error || "Network error"));
        }
      } catch (err) {
        console.warn("Leave group fetch failed:", err);
      }
    }
  });
}

let confirmCallback = null;

function showConfirmModal(options) {
  const modal = document.getElementById("custom-confirm-modal");
  const titleEl = document.getElementById("confirm-modal-title");
  const msgEl = document.getElementById("confirm-modal-message");
  const headerEl = document.getElementById("confirm-modal-header");
  const iconEl = document.getElementById("confirm-modal-icon");
  const actionBtn = document.getElementById("confirm-modal-action-btn");
  
  if (!modal) return;
  
  titleEl.textContent = options.title || "Confirm Action";
  msgEl.textContent = options.message || "Are you sure you want to perform this action?";
  
  // Reset classes and apply type styling
  headerEl.className = "px-6 py-4 flex items-center gap-2.5 text-white bg-gradient-to-r";
  if (options.type === 'danger') {
    headerEl.classList.add("from-rose-500", "to-rose-600");
    iconEl.textContent = options.icon || "⚠️";
    actionBtn.className = "px-5 py-2 text-xs font-extrabold rounded-xl text-white transition-all transform active:scale-95 cursor-pointer shadow-lg bg-rose-500 hover:bg-rose-600 shadow-rose-500/10 hover:shadow-rose-500/20";
  } else if (options.type === 'warning') {
    headerEl.classList.add("from-amber-500", "to-amber-600");
    iconEl.textContent = options.icon || "🔔";
    actionBtn.className = "px-5 py-2 text-xs font-extrabold rounded-xl text-white transition-all transform active:scale-95 cursor-pointer shadow-lg bg-amber-500 hover:bg-amber-600 shadow-amber-500/10 hover:shadow-amber-500/20";
  } else {
    // Default / Info (violet)
    headerEl.classList.add("from-violet-650", "to-violet-700");
    iconEl.textContent = options.icon || "✨";
    actionBtn.className = "px-5 py-2 text-xs font-extrabold rounded-xl text-white transition-all transform active:scale-95 cursor-pointer shadow-lg bg-violet-600 hover:bg-violet-700 shadow-violet-500/10 hover:shadow-violet-500/20";
  }
  
  actionBtn.textContent = options.confirmText || "Confirm";
  
  // Detach prior handlers to prevent memory leaks / double actions
  confirmCallback = () => {
    if (typeof options.onConfirm === 'function') {
      options.onConfirm();
    }
    closeConfirmModal();
  };
  
  actionBtn.onclick = confirmCallback;
  
  // Show and animate
  modal.classList.remove("hidden");
  setTimeout(() => {
    modal.firstElementChild.classList.remove("scale-95");
    modal.firstElementChild.classList.add("scale-100");
  }, 10);
}

function closeConfirmModal() {
  const modal = document.getElementById("custom-confirm-modal");
  if (!modal) return;
  modal.firstElementChild.classList.remove("scale-100");
  modal.firstElementChild.classList.add("scale-95");
  setTimeout(() => {
    modal.classList.add("hidden");
  }, 150);
}

// Attach listeners for sockets live meta changes
document.addEventListener("DOMContentLoaded", () => {
  if (typeof socket !== 'undefined') {
    socket.on('group_meta_updated', (data) => {
      if (data.chat_id === activeChatId) {
        document.getElementById("active-chat-username").textContent = data.group_name;
        document.getElementById("rec-drawer-username").textContent = data.group_name;
        document.getElementById("rec-drawer-group-desc").textContent = data.group_description;
        
        if (data.group_edit_permission) activeGroupEditPermission = data.group_edit_permission;
        if (data.group_send_permission) activeGroupSendPermission = data.group_send_permission;
        
        const editPerm = document.getElementById("edit-group-edit-permission");
        const sendPerm = document.getElementById("edit-group-send-permission");
        if (editPerm && data.group_edit_permission) {
          editPerm.value = data.group_edit_permission;
          if (typeof setSelectPermission === 'function') setSelectPermission('edit', data.group_edit_permission);
        }
        if (sendPerm && data.group_send_permission) {
          sendPerm.value = data.group_send_permission;
          if (typeof setSelectPermission === 'function') setSelectPermission('send', data.group_send_permission);
        }
        
        if (data.group_avatar) {
          document.getElementById("active-chat-avatar").src = data.group_avatar;
          document.getElementById("rec-drawer-avatar").src = data.group_avatar;
        }
        
        // Reload list and details dynamically
        loadGroupMembers(activeChatId);
        loadRecentChats();
      }
    });

    socket.on('group_removed', (data) => {
      if (data.chat_id === activeChatId) {
        alert("You have been removed from this group!");
        closeActiveChat();
        loadRecentChats();
      }
    });
  }
});

async function confirmDeleteChatDirectly(chatId, chatName) {
  showConfirmModal({
    title: "Delete Chat & History",
    message: `Are you sure you want to permanently delete the chat with "${chatName}"? This will erase all message history, shared files, and details permanently.`,
    type: "danger",
    confirmText: "Delete Permanently",
    icon: "🗑️",
    onConfirm: async () => {
      try {
        const res = await fetch('/api/chats/delete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ chat_id: chatId })
        });
        const data = await safeParseJson(res);
        if (data.success) {
          if (activeChatId === chatId) {
            closeActiveChat();
          }
          await loadRecentChats();
        } else {
          showConfirmModal({
            title: "Error",
            message: data.error || "Failed to delete the chat. Please try again.",
            type: "warning",
            confirmText: "OK",
            icon: "🚨"
          });
        }
      } catch (err) {
        console.error("Error deleting chat:", err);
      }
    }
  });
}

// Explicitly bind click-handlers and helper functions to window for template access
window.confirmDeleteChatDirectly = confirmDeleteChatDirectly;
window.leaveGroup = leaveGroup;
window.promoteGroupMember = promoteGroupMember;
window.demoteGroupMember = demoteGroupMember;
window.removeGroupMember = removeGroupMember;
window.saveGroupSettings = saveGroupSettings;
window.setSelectPermission = setSelectPermission;
window.showConfirmModal = showConfirmModal;
window.closeConfirmModal = closeConfirmModal;

