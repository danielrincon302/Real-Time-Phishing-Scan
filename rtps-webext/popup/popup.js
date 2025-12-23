// Real Time Phishing Scan - Popup Script

document.addEventListener('DOMContentLoaded', init);

let currentHost = null;
let currentHostStatus = null;

async function init() {
  setupTabNavigation();
  await loadCurrentSite();
  await loadAllData();
  setupEventListeners();
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
      document.getElementById('site-actions').innerHTML = '';
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

  if (status.isSafe) {
    statusElement.textContent = 'Trusted';
    statusElement.className = 'site-status safe';
    actionsElement.innerHTML = `
      <button class="btn-remove" id="remove-current">Remove from trusted</button>
    `;
  } else if (status.isUnsafe) {
    statusElement.textContent = 'Blocked';
    statusElement.className = 'site-status unsafe';
    actionsElement.innerHTML = `
      <button class="btn-remove" id="remove-current">Remove from blocked</button>
    `;
  } else {
    statusElement.textContent = 'Unknown';
    statusElement.className = 'site-status unknown';
    actionsElement.innerHTML = `
      <button class="btn-safe" id="mark-safe">Mark as Safe</button>
      <button class="btn-unsafe" id="mark-unsafe">Mark as Unsafe</button>
    `;
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

    if (!detected || detected.length === 0) {
      list.innerHTML = '<li class="empty-message">No phishing attempts detected</li>';
      return;
    }

    list.innerHTML = detected.map(entry => `
      <li class="detected-item">
        <div class="host-item-info">
          <span class="host-item-name">${escapeHtml(entry.host)}</span>
          <span class="host-item-meta">${formatDate(entry.timestamp)}</span>
          ${entry.referrer ? `<span class="host-item-referrer">From: ${escapeHtml(entry.referrer)}</span>` : ''}
          ${entry.redirectChain && entry.redirectChain.length > 0 ? `
            <span class="host-item-chain">Path: ${entry.redirectChain.map(h => escapeHtml(h)).join(' → ')}</span>
          ` : ''}
          ${entry.reason ? `<span class="host-item-reason">${escapeHtml(entry.reason)}</span>` : ''}
        </div>
        <div class="host-item-actions">
          <button class="btn-icon trust" data-host="${escapeHtml(entry.host)}" title="Trust this site">&#10003;</button>
          <button class="btn-icon delete" data-url="${escapeHtml(entry.url)}" title="Remove">&#10005;</button>
        </div>
      </li>
    `).join('');

    // Add event listeners
    list.querySelectorAll('.btn-icon.trust').forEach(btn => {
      btn.addEventListener('click', async () => {
        await browser.runtime.sendMessage({
          action: 'ADD_SAFE_HOST',
          data: { host: btn.dataset.host }
        });
        await loadAllData();
        await loadCurrentSite();
      });
    });
  } catch (error) {
    console.error('Error loading detected list:', error);
  }
}

async function loadHostLists() {
  try {
    const hosts = await browser.runtime.sendMessage({ action: 'GET_ALL_HOSTS' });

    // Safe hosts
    const safeList = document.getElementById('safe-list');
    if (hosts.safeHosts.length === 0) {
      safeList.innerHTML = '<li class="empty-message">No safe sites added</li>';
    } else {
      safeList.innerHTML = hosts.safeHosts.map(host => `
        <li>
          <div class="host-item-info">
            <span class="host-item-name">${escapeHtml(host)}</span>
          </div>
          <div class="host-item-actions">
            <button class="btn-icon delete" data-host="${escapeHtml(host)}" title="Remove">&#10005;</button>
          </div>
        </li>
      `).join('');

      safeList.querySelectorAll('.btn-icon.delete').forEach(btn => {
        btn.addEventListener('click', async () => {
          await browser.runtime.sendMessage({
            action: 'REMOVE_HOST',
            data: { host: btn.dataset.host }
          });
          await loadHostLists();
          await loadCurrentSite();
        });
      });
    }

    // Unsafe hosts
    const unsafeList = document.getElementById('unsafe-list');
    if (hosts.unsafeHosts.length === 0) {
      unsafeList.innerHTML = '<li class="empty-message">No unsafe sites added</li>';
    } else {
      unsafeList.innerHTML = hosts.unsafeHosts.map(host => `
        <li>
          <div class="host-item-info">
            <span class="host-item-name">${escapeHtml(host)}</span>
          </div>
          <div class="host-item-actions">
            <button class="btn-icon delete" data-host="${escapeHtml(host)}" title="Remove">&#10005;</button>
          </div>
        </li>
      `).join('');

      unsafeList.querySelectorAll('.btn-icon.delete').forEach(btn => {
        btn.addEventListener('click', async () => {
          await browser.runtime.sendMessage({
            action: 'REMOVE_HOST',
            data: { host: btn.dataset.host }
          });
          await loadHostLists();
          await loadCurrentSite();
        });
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
}

// Helper functions
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
