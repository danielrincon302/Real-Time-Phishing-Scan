// Real Time Phishing Scan - Popup Script

document.addEventListener('DOMContentLoaded', init);

let currentHost = null;
let currentHostStatus = null;
let translations = {};
let currentLanguage = 'en';

async function init() {
  await loadLanguage();
  setupTabNavigation();
  await loadCurrentSite();
  await loadAllData();
  setupEventListeners();
}

// Internationalization functions
async function loadLanguage() {
  try {
    // Get saved language from settings
    const settings = await browser.runtime.sendMessage({ action: 'GET_SETTINGS' });
    currentLanguage = settings.language || 'en';

    // Load translations
    await loadTranslations(currentLanguage);

    // Set the language selector value
    const langSelect = document.getElementById('setting-language');
    if (langSelect) {
      langSelect.value = currentLanguage;
    }

    // Apply translations to the DOM
    applyTranslations();
  } catch (error) {
    console.error('Error loading language:', error);
  }
}

async function loadTranslations(lang) {
  try {
    const url = browser.runtime.getURL(`_locales/${lang}/messages.json`);
    const response = await fetch(url);
    translations = await response.json();
  } catch (error) {
    console.error('Error loading translations:', error);
    // Fallback to English if loading fails
    if (lang !== 'en') {
      await loadTranslations('en');
    }
  }
}

function getMessage(key, substitutions = []) {
  const message = translations[key];
  if (!message) return key;

  let text = message.message;

  // Handle substitutions ($1, $2, etc.)
  if (substitutions.length > 0 && message.placeholders) {
    Object.keys(message.placeholders).forEach((placeholder, index) => {
      const regex = new RegExp(`\\$${placeholder.toUpperCase()}\\$`, 'g');
      text = text.replace(regex, substitutions[index] || '');
    });
  }

  return text;
}

function applyTranslations() {
  // Apply translations to elements with data-i18n attribute
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const translated = getMessage(key);
    if (translated && translated !== key) {
      el.textContent = translated;
    }
  });

  // Apply translations to placeholder attributes
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    const translated = getMessage(key);
    if (translated && translated !== key) {
      el.placeholder = translated;
    }
  });
}

async function changeLanguage(lang) {
  currentLanguage = lang;

  // Save to settings
  await browser.runtime.sendMessage({
    action: 'UPDATE_SETTINGS',
    data: { settings: { language: lang } }
  });

  // Reload translations and apply
  await loadTranslations(lang);
  applyTranslations();

  // Reload dynamic content
  await loadAllData();
  await loadCurrentSite();
}

function setupTabNavigation() {
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.tab;

      tabButtons.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      document.getElementById(`${tabId}-tab`).classList.add('active');
    });
  });
}

async function loadCurrentSite() {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs.length === 0) return;

    const tab = tabs[0];
    const url = new URL(tab.url);

    // Handle special URLs
    if (url.protocol === 'about:' || url.protocol === 'chrome:' || url.protocol === 'moz-extension:') {
      document.getElementById('current-host').textContent = 'Browser page';
      document.getElementById('current-status').textContent = 'N/A';
      document.getElementById('site-actions').textContent = '';
      return;
    }

    currentHost = url.hostname;
    document.getElementById('current-host').textContent = currentHost;

    // Check host status
    const response = await browser.runtime.sendMessage({
      action: 'CHECK_HOST_STATUS',
      data: { host: currentHost }
    });

    currentHostStatus = response;
    updateCurrentSiteStatus(response);
  } catch (error) {
    console.error('Error loading current site:', error);
    document.getElementById('current-host').textContent = 'Unable to detect';
  }
}

function updateCurrentSiteStatus(status) {
  const statusElement = document.getElementById('current-status');
  const actionsElement = document.getElementById('site-actions');

  // Clear previous actions
  actionsElement.textContent = '';

  if (status.isSafe) {
    statusElement.textContent = getMessage('statusSafe');
    statusElement.className = 'site-status safe';
    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn-remove';
    removeBtn.id = 'remove-current';
    removeBtn.textContent = getMessage('delete');
    actionsElement.appendChild(removeBtn);
  } else if (status.isUnsafe) {
    statusElement.textContent = getMessage('statusUnsafe');
    statusElement.className = 'site-status unsafe';
    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn-remove';
    removeBtn.id = 'remove-current';
    removeBtn.textContent = getMessage('delete');
    actionsElement.appendChild(removeBtn);
  } else {
    statusElement.textContent = getMessage('statusUnknown');
    statusElement.className = 'site-status unknown';
    const markSafeBtn = document.createElement('button');
    markSafeBtn.className = 'btn-safe';
    markSafeBtn.id = 'mark-safe';
    markSafeBtn.textContent = getMessage('markAsSafe');
    const markUnsafeBtn = document.createElement('button');
    markUnsafeBtn.className = 'btn-unsafe';
    markUnsafeBtn.id = 'mark-unsafe';
    markUnsafeBtn.textContent = getMessage('markAsUnsafe');
    actionsElement.appendChild(markSafeBtn);
    actionsElement.appendChild(markUnsafeBtn);
  }

  // Add event listeners for new buttons
  const markSafeBtn = document.getElementById('mark-safe');
  const markUnsafeBtn = document.getElementById('mark-unsafe');
  const removeCurrentBtn = document.getElementById('remove-current');

  if (markSafeBtn) {
    markSafeBtn.addEventListener('click', () => addCurrentHost(true));
  }
  if (markUnsafeBtn) {
    markUnsafeBtn.addEventListener('click', () => addCurrentHost(false));
  }
  if (removeCurrentBtn) {
    removeCurrentBtn.addEventListener('click', removeCurrentHost);
  }
}

async function addCurrentHost(isSafe) {
  if (!currentHost) return;

  try {
    await browser.runtime.sendMessage({
      action: isSafe ? 'ADD_SAFE_HOST' : 'ADD_UNSAFE_HOST',
      data: { host: currentHost }
    });

    await loadCurrentSite();
    await loadAllData();
  } catch (error) {
    console.error('Error adding host:', error);
  }
}

async function removeCurrentHost() {
  if (!currentHost) return;

  try {
    await browser.runtime.sendMessage({
      action: 'REMOVE_HOST',
      data: { host: currentHost }
    });

    await loadCurrentSite();
    await loadAllData();
  } catch (error) {
    console.error('Error removing host:', error);
  }
}

async function loadAllData() {
  await Promise.all([
    loadDetectedList(),
    loadHostLists(),
    loadSettings()
  ]);
}

async function loadDetectedList() {
  try {
    const detected = await browser.runtime.sendMessage({ action: 'GET_DETECTED_PHISHING' });
    const list = document.getElementById('detected-list');

    // Clear list
    list.textContent = '';

    if (!detected || detected.length === 0) {
      const emptyLi = document.createElement('li');
      emptyLi.className = 'empty-message';
      emptyLi.textContent = getMessage('noDetections');
      list.appendChild(emptyLi);
      return;
    }

    detected.forEach(entry => {
      const li = document.createElement('li');
      li.className = 'detected-item';

      const infoDiv = document.createElement('div');
      infoDiv.className = 'host-item-info';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'host-item-name';
      nameSpan.textContent = entry.host;
      infoDiv.appendChild(nameSpan);

      const metaSpan = document.createElement('span');
      metaSpan.className = 'host-item-meta';
      metaSpan.textContent = formatDate(entry.timestamp);
      infoDiv.appendChild(metaSpan);

      if (entry.referrer) {
        const referrerSpan = document.createElement('span');
        referrerSpan.className = 'host-item-referrer';
        referrerSpan.textContent = getMessage('from') + ': ' + entry.referrer;
        infoDiv.appendChild(referrerSpan);
      }

      if (entry.redirectChain && entry.redirectChain.length > 0) {
        const chainSpan = document.createElement('span');
        chainSpan.className = 'host-item-chain';
        chainSpan.textContent = getMessage('navigationPath') + ' ' + entry.redirectChain.join(' → ');
        infoDiv.appendChild(chainSpan);
      }

      if (entry.reason) {
        const reasonSpan = document.createElement('span');
        reasonSpan.className = 'host-item-reason';
        reasonSpan.textContent = entry.reason;
        infoDiv.appendChild(reasonSpan);
      }

      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'host-item-actions';

      const trustBtn = document.createElement('button');
      trustBtn.className = 'btn-icon trust';
      trustBtn.dataset.host = entry.host;
      trustBtn.title = getMessage('trustThisSite');
      trustBtn.textContent = '✓';
      trustBtn.addEventListener('click', async () => {
        await browser.runtime.sendMessage({
          action: 'ADD_SAFE_HOST',
          data: { host: entry.host }
        });
        await loadAllData();
        await loadCurrentSite();
      });
      actionsDiv.appendChild(trustBtn);

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn-icon delete';
      deleteBtn.dataset.url = entry.url;
      deleteBtn.title = getMessage('delete');
      deleteBtn.textContent = '✗';
      actionsDiv.appendChild(deleteBtn);

      li.appendChild(infoDiv);
      li.appendChild(actionsDiv);
      list.appendChild(li);
    });
  } catch (error) {
    console.error('Error loading detected list:', error);
  }
}

async function loadHostLists() {
  try {
    const hosts = await browser.runtime.sendMessage({ action: 'GET_ALL_HOSTS' });

    // Helper to create host list item
    function createHostListItem(host, onDelete) {
      const li = document.createElement('li');

      const infoDiv = document.createElement('div');
      infoDiv.className = 'host-item-info';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'host-item-name';
      nameSpan.textContent = host;
      infoDiv.appendChild(nameSpan);

      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'host-item-actions';

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn-icon delete';
      deleteBtn.dataset.host = host;
      deleteBtn.title = getMessage('delete');
      deleteBtn.textContent = '✗';
      deleteBtn.addEventListener('click', onDelete);
      actionsDiv.appendChild(deleteBtn);

      li.appendChild(infoDiv);
      li.appendChild(actionsDiv);
      return li;
    }

    // Safe hosts
    const safeList = document.getElementById('safe-list');
    safeList.textContent = '';

    if (hosts.safeHosts.length === 0) {
      const emptyLi = document.createElement('li');
      emptyLi.className = 'empty-message';
      emptyLi.textContent = getMessage('noSafeSites');
      safeList.appendChild(emptyLi);
    } else {
      hosts.safeHosts.forEach(host => {
        const li = createHostListItem(host, async () => {
          await browser.runtime.sendMessage({
            action: 'REMOVE_HOST',
            data: { host }
          });
          await loadHostLists();
          await loadCurrentSite();
        });
        safeList.appendChild(li);
      });
    }

    // Unsafe hosts
    const unsafeList = document.getElementById('unsafe-list');
    unsafeList.textContent = '';

    if (hosts.unsafeHosts.length === 0) {
      const emptyLi = document.createElement('li');
      emptyLi.className = 'empty-message';
      emptyLi.textContent = getMessage('noUnsafeSites');
      unsafeList.appendChild(emptyLi);
    } else {
      hosts.unsafeHosts.forEach(host => {
        const li = createHostListItem(host, async () => {
          await browser.runtime.sendMessage({
            action: 'REMOVE_HOST',
            data: { host }
          });
          await loadHostLists();
          await loadCurrentSite();
        });
        unsafeList.appendChild(li);
      });
    }
  } catch (error) {
    console.error('Error loading host lists:', error);
  }
}

async function loadSettings() {
  try {
    const settings = await browser.runtime.sendMessage({ action: 'GET_SETTINGS' });

    document.getElementById('setting-enabled').checked = settings.enabled;
    document.getElementById('setting-notifications').checked = settings.showNotifications;

    // Set language selector
    const langSelect = document.getElementById('setting-language');
    if (langSelect && settings.language) {
      langSelect.value = settings.language;
    }
  } catch (error) {
    console.error('Error loading settings:', error);
  }
}

function setupEventListeners() {
  // Clear detected
  document.getElementById('clear-detected').addEventListener('click', async () => {
    await browser.runtime.sendMessage({ action: 'CLEAR_DETECTED_PHISHING' });
    await loadDetectedList();
  });

  // Add safe host
  document.getElementById('add-safe-btn').addEventListener('click', async () => {
    const input = document.getElementById('add-safe-input');
    const host = input.value.trim();
    if (!host) return;

    await browser.runtime.sendMessage({
      action: 'ADD_SAFE_HOST',
      data: { host }
    });

    input.value = '';
    await loadHostLists();
    await loadCurrentSite();
  });

  // Add unsafe host
  document.getElementById('add-unsafe-btn').addEventListener('click', async () => {
    const input = document.getElementById('add-unsafe-input');
    const host = input.value.trim();
    if (!host) return;

    await browser.runtime.sendMessage({
      action: 'ADD_UNSAFE_HOST',
      data: { host }
    });

    input.value = '';
    await loadHostLists();
    await loadCurrentSite();
  });

  // Enter key for inputs
  document.getElementById('add-safe-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      document.getElementById('add-safe-btn').click();
    }
  });

  document.getElementById('add-unsafe-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      document.getElementById('add-unsafe-btn').click();
    }
  });

  // Settings
  document.getElementById('setting-enabled').addEventListener('change', async (e) => {
    await browser.runtime.sendMessage({
      action: 'UPDATE_SETTINGS',
      data: { settings: { enabled: e.target.checked } }
    });
  });

  document.getElementById('setting-notifications').addEventListener('change', async (e) => {
    await browser.runtime.sendMessage({
      action: 'UPDATE_SETTINGS',
      data: { settings: { showNotifications: e.target.checked } }
    });
  });

  // Language selector
  document.getElementById('setting-language').addEventListener('change', async (e) => {
    await changeLanguage(e.target.value);
  });
}

// Helper functions
function formatDate(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
