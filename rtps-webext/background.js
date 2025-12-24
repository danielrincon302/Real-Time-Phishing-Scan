// Real Time Phishing Scan - Background Service Worker
// Migrated from Firefox 3.6 XUL extension to WebExtensions Manifest V3

const STORAGE_KEYS = {
  SAFE_HOSTS: 'safeHosts',
  UNSAFE_HOSTS: 'unsafeHosts',
  DETECTED_PHISHING: 'detectedPhishing',
  SETTINGS: 'settings'
};

// Default known safe sites - major websites that legitimately ask for passwords
const DEFAULT_SAFE_HOSTS = [
  // Microsoft
  'microsoft.com', 'live.com', 'outlook.com', 'hotmail.com', 'office.com',
  'microsoftonline.com', 'azure.com', 'xbox.com', 'skype.com', 'linkedin.com',
  'github.com', 'visualstudio.com', 'windows.com', 'bing.com', 'msn.com',

  // Google
  'google.com', 'gmail.com', 'youtube.com', 'googleapis.com', 'gstatic.com',
  'accounts.google.com', 'cloud.google.com', 'drive.google.com',

  // Meta/Facebook
  'facebook.com', 'instagram.com', 'whatsapp.com', 'messenger.com', 'meta.com',
  'fb.com', 'fbcdn.net',

  // Apple
  'apple.com', 'icloud.com', 'appleid.apple.com', 'itunes.com',

  // Amazon
  'amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.es', 'amazon.fr',
  'amazon.it', 'amazon.com.mx', 'amazon.com.br', 'aws.amazon.com', 'amazonaws.com',

  // Social Media
  'twitter.com', 'x.com', 'tiktok.com', 'reddit.com', 'pinterest.com',
  'tumblr.com', 'snapchat.com', 'discord.com', 'twitch.tv',

  // Payment/Banking (common ones)
  'paypal.com', 'stripe.com', 'venmo.com', 'wise.com', 'revolut.com',

  // Ecommerce
  'ebay.com', 'etsy.com', 'shopify.com', 'aliexpress.com', 'alibaba.com',
  'mercadolibre.com', 'mercadolibre.com.mx', 'mercadolibre.com.co',

  // Streaming
  'netflix.com', 'spotify.com', 'hulu.com', 'disneyplus.com', 'hbomax.com',
  'primevideo.com', 'twitch.tv', 'crunchyroll.com',

  // Work/Productivity
  'slack.com', 'zoom.us', 'dropbox.com', 'box.com', 'notion.so',
  'trello.com', 'asana.com', 'atlassian.com', 'jira.com', 'confluence.com',
  'salesforce.com', 'hubspot.com', 'zendesk.com',

  // Developer
  'gitlab.com', 'bitbucket.org', 'stackoverflow.com', 'npmjs.com',
  'docker.com', 'heroku.com', 'vercel.com', 'netlify.com', 'cloudflare.com',

  // Education
  'coursera.org', 'udemy.com', 'edx.org', 'khanacademy.org',

  // Others
  'wordpress.com', 'blogger.com', 'medium.com', 'quora.com',
  'yahoo.com', 'aol.com', 'proton.me', 'protonmail.com'
];

// Default settings
const DEFAULT_SETTINGS = {
  enabled: true,
  showNotifications: true,
  redirectLevels: 4,  // Maximum redirect levels to track
  language: 'en'
};

// Cache for translations
let cachedTranslations = {};
let cachedLanguage = 'en';

// Load translations for background script
async function loadBackgroundTranslations() {
  try {
    const settings = await getSettings();
    cachedLanguage = settings.language || 'en';

    const url = browser.runtime.getURL(`_locales/${cachedLanguage}/messages.json`);
    const response = await fetch(url);
    cachedTranslations = await response.json();
  } catch (error) {
    console.error('RTPS: Error loading translations:', error);
    // Fallback to English
    try {
      const url = browser.runtime.getURL('_locales/en/messages.json');
      const response = await fetch(url);
      cachedTranslations = await response.json();
    } catch (e) {
      console.error('RTPS: Error loading fallback translations:', e);
    }
  }
}

function getBackgroundMessage(key, substitutions = []) {
  const message = cachedTranslations[key];
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

// Navigation history per tab - tracks the chain of domains visited
// Structure: { tabId: [{ host, url, timestamp }, ...] }
const tabNavigationHistory = new Map();

// Track source tab when a link opens a new tab
// Structure: { destinationTabId: { sourceTabId, sourceUrl, sourceHost, timestamp } }
const tabSourceMap = new Map();

// Track HTTP Referer headers for each tab
// Structure: { tabId: { referer, url, timestamp } }
const tabRefererMap = new Map();

// Maximum history entries per tab
const MAX_HISTORY_PER_TAB = 10;

// Initialize storage on install
browser.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await browser.storage.local.set({
      [STORAGE_KEYS.SAFE_HOSTS]: [...DEFAULT_SAFE_HOSTS],
      [STORAGE_KEYS.UNSAFE_HOSTS]: [],
      [STORAGE_KEYS.DETECTED_PHISHING]: [],
      [STORAGE_KEYS.SETTINGS]: DEFAULT_SETTINGS
    });
    console.log('RTPS: Extension installed with default safe hosts');
  } else if (details.reason === 'update') {
    // Merge new default safe hosts on update
    const storage = await browser.storage.local.get(STORAGE_KEYS.SAFE_HOSTS);
    const currentSafeHosts = storage[STORAGE_KEYS.SAFE_HOSTS] || [];
    const mergedHosts = [...new Set([...currentSafeHosts, ...DEFAULT_SAFE_HOSTS])];
    await browser.storage.local.set({ [STORAGE_KEYS.SAFE_HOSTS]: mergedHosts });
    console.log('RTPS: Extension updated, safe hosts merged');
  }

  // Load translations after install/update
  await loadBackgroundTranslations();
});

// Load translations on startup
loadBackgroundTranslations();

// Track navigation for each tab
browser.webNavigation.onCommitted.addListener((details) => {
  // Only track main frame navigations
  if (details.frameId !== 0) return;

  const { tabId, url, transitionType, transitionQualifiers } = details;

  try {
    const urlObj = new URL(url);
    // Skip browser internal pages
    if (urlObj.protocol === 'about:' || urlObj.protocol === 'chrome:' ||
        urlObj.protocol === 'moz-extension:' || urlObj.protocol === 'file:') {
      return;
    }

    const host = urlObj.hostname;
    const normalizedHost = normalizeHost(host);

    if (!tabNavigationHistory.has(tabId)) {
      tabNavigationHistory.set(tabId, []);
    }

    const history = tabNavigationHistory.get(tabId);
    const lastEntry = history[history.length - 1];

    // Determine how user arrived at this page
    // transitionType values: "link", "typed", "auto_bookmark", "auto_subframe",
    // "manual_subframe", "generated", "start_page", "form_submit", "reload", "keyword", "keyword_generated"
    // transitionQualifiers: "client_redirect", "server_redirect", "forward_back", "from_address_bar"
    const isFromLink = transitionType === 'link';
    const isTypedDirectly = transitionType === 'typed' || transitionQualifiers?.includes('from_address_bar');
    const isRedirect = transitionQualifiers?.includes('client_redirect') ||
                       transitionQualifiers?.includes('server_redirect');
    const isFormSubmit = transitionType === 'form_submit';

    // Only add if different from last entry (avoid duplicates from same-page navigations)
    if (!lastEntry || lastEntry.host !== normalizedHost) {
      history.push({
        host: normalizedHost,
        url: url,
        timestamp: Date.now(),
        transitionType,
        transitionQualifiers: transitionQualifiers || [],
        isFromLink,
        isTypedDirectly,
        isRedirect
      });

      // Keep only last N entries
      if (history.length > MAX_HISTORY_PER_TAB) {
        history.shift();
      }
    }

    // Log navigation with transition info for debugging
    const transitionInfo = isTypedDirectly ? '(typed directly)' :
                          isFromLink ? '(from link click)' :
                          isRedirect ? '(redirect)' :
                          isFormSubmit ? '(form submit)' : `(${transitionType})`;
    console.log(`RTPS: Tab ${tabId} navigated to ${normalizedHost} ${transitionInfo}. History:`,
      history.map(h => h.host).join(' -> '));

    // PROACTIVE CROSS-DOMAIN DETECTION: Check immediately when navigating from a safe site
    // Only check if user clicked a link or was redirected (not if they typed URL directly)

    // Also check HTTP Referer for this tab (may have been set by onBeforeSendHeaders)
    const refererInfo = tabRefererMap.get(tabId);
    const refererHost = refererInfo?.refererHost;

    console.log(`RTPS: Cross-domain check - isTypedDirectly: ${isTypedDirectly}, lastEntry: ${lastEntry?.host || 'none'}, refererHost: ${refererHost || 'none'}, tabSourceMap has: ${tabSourceMap.has(tabId)}`);

    if (!isTypedDirectly) {
      let sourceHost = null;
      let sourceType = null;

      // Priority 1: HTTP Referer (most reliable for cross-tab navigation)
      if (refererHost && !isSameDomain(refererHost, normalizedHost)) {
        sourceHost = refererHost;
        sourceType = 'referer';
      }
      // Priority 2: Navigation history within the same tab
      else if (lastEntry && !isSameDomain(lastEntry.host, normalizedHost)) {
        sourceHost = lastEntry.host;
        sourceType = 'history';
      }
      // Priority 3: If this tab was opened from another tab
      else if (tabSourceMap.has(tabId)) {
        const sourceInfo = tabSourceMap.get(tabId);
        if (!isSameDomain(sourceInfo.sourceHost, normalizedHost)) {
          sourceHost = sourceInfo.sourceHost;
          sourceType = 'sourceTab';
        }
      }

      if (sourceHost) {
        console.log(`RTPS: Triggering cross-domain check (${sourceType}): ${sourceHost} -> ${normalizedHost}`);
        checkCrossDomainNavigation(tabId, sourceHost, normalizedHost, isFromLink, isRedirect, url);
      } else {
        console.log(`RTPS: No cross-domain trigger - no different source domain found`);
      }
    } else {
      // User typed URL directly - clear all navigation history for this tab
      // This is a fresh navigation initiated by the user, not from a link
      console.log(`RTPS: URL typed directly - clearing navigation history for tab ${tabId}`);
      tabNavigationHistory.set(tabId, [{
        host: normalizedHost,
        url: url,
        timestamp: Date.now(),
        transitionType,
        transitionQualifiers: transitionQualifiers || [],
        isFromLink: false,
        isTypedDirectly: true,
        isRedirect: false
      }]);
      tabCrossDomainContext.delete(tabId);
      tabSourceMap.delete(tabId);
      tabRefererMap.delete(tabId);
      updateBadge(tabId, 'default');
    }

  } catch (error) {
    console.error('RTPS: Error tracking navigation', error);
  }
});

// Track cross-domain navigation context per tab
// Structure: { tabId: { sourceHost, destinationHost, navigationMethod, timestamp } }
const tabCrossDomainContext = new Map();

// Proactive cross-domain navigation check
// This stores the cross-domain context but only alerts when password fields are detected
async function checkCrossDomainNavigation(tabId, sourceHost, destinationHost, isFromLink, isRedirect, destinationUrl) {
  console.log(`RTPS: checkCrossDomainNavigation called - source: ${sourceHost}, dest: ${destinationHost}`);
  try {
    const settings = await getSettings();
    if (!settings.enabled) {
      console.log(`RTPS: Extension disabled, skipping`);
      return;
    }

    // Check if source is a safe/trusted site
    const sourceStatus = await checkHostStatus(sourceHost);
    console.log(`RTPS: Source "${sourceHost}" status:`, sourceStatus);
    if (!sourceStatus.isSafe) {
      // Source is not a trusted site, clear any context
      console.log(`RTPS: Source is not safe, clearing context`);
      tabCrossDomainContext.delete(tabId);
      return;
    }

    // Check if destination is unknown (not safe, not unsafe)
    const destStatus = await checkHostStatus(destinationHost);
    if (destStatus.isSafe) {
      // Destination is also safe, no alert needed
      tabCrossDomainContext.delete(tabId);
      await updateBadge(tabId, 'safe');
      return;
    }

    if (destStatus.isUnsafe) {
      // Destination is known phishing/unsafe site - HIGH ALERT immediately
      await updateBadge(tabId, 'danger');
      await showNotification(
        getBackgroundMessage('notifDangerTitle'),
        getBackgroundMessage('notifDangerMessage', [sourceHost, destinationHost])
      );
      return;
    }

    // Destination is UNKNOWN - store context for when password field is detected
    const navigationMethod = isFromLink ? 'clicked a link' : isRedirect ? 'were redirected' : 'navigated';

    console.log(`RTPS: Cross-domain context stored: ${sourceHost} (SAFE) -> ${destinationHost} (UNKNOWN) via ${navigationMethod}`);

    // Store the cross-domain context for this tab
    tabCrossDomainContext.set(tabId, {
      sourceHost,
      destinationHost,
      navigationMethod,
      destinationUrl,
      timestamp: Date.now()
    });

    // Set warning badge (subtle indicator)
    await updateBadge(tabId, 'warning');

  } catch (error) {
    console.error('RTPS: Error in checkCrossDomainNavigation', error);
  }
}

// Get cross-domain context for a tab
function getCrossDomainContext(tabId) {
  const context = tabCrossDomainContext.get(tabId);
  if (context) {
    // Context expires after 10 minutes
    if (Date.now() - context.timestamp < 10 * 60 * 1000) {
      return context;
    }
    tabCrossDomainContext.delete(tabId);
  }
  return null;
}

// Clean up when tab is closed
browser.tabs.onRemoved.addListener((tabId) => {
  tabNavigationHistory.delete(tabId);
  tabSourceMap.delete(tabId);
  tabRefererMap.delete(tabId);
  tabCrossDomainContext.delete(tabId);
});

// Track when a link opens a new tab - this is KEY for detecting phishing!
// This fires when user clicks a link that opens in a new tab
browser.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  const { sourceTabId, tabId, url } = details;

  // Get the source tab's current URL
  browser.tabs.get(sourceTabId).then((sourceTab) => {
    if (sourceTab && sourceTab.url) {
      try {
        const sourceUrl = new URL(sourceTab.url);
        const sourceHost = normalizeHost(sourceUrl.hostname);

        // Store the relationship: this new tab was opened from sourceTab
        tabSourceMap.set(tabId, {
          sourceTabId,
          sourceUrl: sourceTab.url,
          sourceHost,
          timestamp: Date.now()
        });

        console.log(`RTPS: New tab ${tabId} opened from tab ${sourceTabId} (${sourceHost})`);

        // Also copy the navigation history from source tab to give context
        const sourceHistory = tabNavigationHistory.get(sourceTabId) || [];
        if (sourceHistory.length > 0) {
          tabNavigationHistory.set(tabId, [...sourceHistory]);
        } else {
          // At minimum, add the source host to the new tab's history
          tabNavigationHistory.set(tabId, [{
            host: sourceHost,
            url: sourceTab.url,
            timestamp: Date.now()
          }]);
        }
      } catch (e) {
        console.error('RTPS: Error processing source tab', e);
      }
    }
  }).catch((e) => {
    console.log('RTPS: Could not get source tab info', e);
  });
});

// Capture HTTP Referer header from requests
browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    // Only track main frame requests
    if (details.type !== 'main_frame') return;

    const { tabId, url, requestHeaders } = details;

    // Find the Referer header
    const refererHeader = requestHeaders.find(h => h.name.toLowerCase() === 'referer');

    if (refererHeader && refererHeader.value) {
      try {
        const refererUrl = new URL(refererHeader.value);
        const refererHost = normalizeHost(refererUrl.hostname);

        tabRefererMap.set(tabId, {
          referer: refererHeader.value,
          refererHost,
          url,
          timestamp: Date.now()
        });

        console.log(`RTPS: Tab ${tabId} has HTTP Referer: ${refererHost}`);

        // Also add to navigation history if not already there
        if (!tabNavigationHistory.has(tabId)) {
          tabNavigationHistory.set(tabId, []);
        }
        const history = tabNavigationHistory.get(tabId);
        if (history.length === 0 || history[history.length - 1].host !== refererHost) {
          // Add referer as first entry in history
          history.unshift({
            host: refererHost,
            url: refererHeader.value,
            timestamp: Date.now(),
            fromReferer: true
          });
        }
      } catch (e) {
        // Invalid referer URL
      }
    }
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders"]
);

// Listen for messages from content scripts
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse);
  return true; // Keep channel open for async response
});

async function handleMessage(message, sender) {
  const { action, data } = message;

  switch (action) {
    case 'PASSWORD_FIELD_DETECTED':
      return await handlePasswordFieldDetected(data, sender.tab);

    case 'CHECK_HOST_STATUS':
      return await checkHostStatus(data.host);

    case 'CHECK_PHISHING_RISK':
      return await checkPhishingRisk(data, sender.tab);

    case 'ADD_SAFE_HOST':
      return await addHost(data.host, true);

    case 'ADD_UNSAFE_HOST':
      return await addHost(data.host, false);

    case 'REMOVE_HOST':
      return await removeHost(data.host);

    case 'GET_ALL_HOSTS':
      return await getAllHosts();

    case 'GET_DETECTED_PHISHING':
      return await getDetectedPhishing();

    case 'CLEAR_DETECTED_PHISHING':
      return await clearDetectedPhishing();

    case 'GET_SETTINGS':
      return await getSettings();

    case 'UPDATE_SETTINGS':
      return await updateSettings(data.settings);

    case 'GET_NAVIGATION_HISTORY':
      return getNavigationHistory(sender.tab.id);

    default:
      console.warn('RTPS: Unknown action', action);
      return { success: false, error: 'Unknown action' };
  }
}

async function handlePasswordFieldDetected(data, tab) {
  const { host, url, referrer } = data;
  const normalizedHost = normalizeHost(host);

  // First check if current host is explicitly marked
  const hostStatus = await checkHostStatus(normalizedHost);

  if (hostStatus.isUnsafe) {
    // Host is known unsafe - always alert
    await updateBadge(tab.id, 'danger');
    await showNotification(
      getBackgroundMessage('notifDangerTitle'),
      getBackgroundMessage('doNotEnterPassword')
    );
    return { status: 'unsafe', host: normalizedHost, alert: true, highlightFields: true };
  }

  if (hostStatus.isSafe) {
    // Host is known safe - no alert needed
    await updateBadge(tab.id, 'safe');
    return { status: 'safe', host: normalizedHost, alert: false };
  }

  // Check if we have cross-domain context for this tab (from earlier navigation)
  const crossDomainContext = getCrossDomainContext(tab.id);
  console.log(`RTPS: handlePasswordFieldDetected - crossDomainContext:`, crossDomainContext);

  // Host is unknown - check navigation history for cross-domain phishing pattern
  // IMPORTANT: Only analyze if there's a referrer or navigation history
  // If user typed URL directly, no phishing risk from redirects
  const phishingRisk = await analyzePhishingRisk(tab.id, normalizedHost, referrer);

  // If we have cross-domain context AND password field detected, this is HIGH RISK
  if (crossDomainContext && crossDomainContext.destinationHost === normalizedHost) {
    const detectedEntry = {
      host: normalizedHost,
      url,
      referrer: crossDomainContext.sourceHost,
      redirectChain: [crossDomainContext.sourceHost, normalizedHost],
      timestamp: Date.now(),
      reason: `Password field detected after navigating from trusted site "${crossDomainContext.sourceHost}" to unknown site "${normalizedHost}"`,
      type: 'cross_domain_password'
    };

    // Add to detected phishing list
    const storage = await browser.storage.local.get(STORAGE_KEYS.DETECTED_PHISHING);
    const detected = storage[STORAGE_KEYS.DETECTED_PHISHING] || [];

    if (!detected.some(entry => entry.url === url)) {
      detected.push(detectedEntry);
      await browser.storage.local.set({ [STORAGE_KEYS.DETECTED_PHISHING]: detected });
    }

    await updateBadge(tab.id, 'danger');
    await showNotification(
      getBackgroundMessage('notifPhishingTitle'),
      getBackgroundMessage('notifPhishingMessage', [crossDomainContext.navigationMethod, crossDomainContext.sourceHost, normalizedHost])
    );

    // Clear context after alerting
    tabCrossDomainContext.delete(tab.id);

    return {
      status: 'phishing',
      host: normalizedHost,
      alert: true,
      highlightFields: true,
      sourceHost: crossDomainContext.sourceHost,
      redirectChain: [crossDomainContext.sourceHost, normalizedHost],
      reason: detectedEntry.reason,
      navigationMethod: crossDomainContext.navigationMethod
    };
  }

  if (phishingRisk.isHighRisk) {
    // Detected cross-domain phishing pattern
    const detectedEntry = {
      host: normalizedHost,
      url,
      referrer: phishingRisk.sourceHost,
      redirectChain: phishingRisk.redirectChain,
      timestamp: Date.now(),
      reason: phishingRisk.reason
    };

    // Add to detected phishing list
    const storage = await browser.storage.local.get(STORAGE_KEYS.DETECTED_PHISHING);
    const detected = storage[STORAGE_KEYS.DETECTED_PHISHING] || [];

    // Avoid duplicates
    if (!detected.some(entry => entry.url === url)) {
      detected.push(detectedEntry);
      await browser.storage.local.set({ [STORAGE_KEYS.DETECTED_PHISHING]: detected });
    }

    await updateBadge(tab.id, 'danger');
    await showNotification(
      getBackgroundMessage('phishingDetected'),
      getBackgroundMessage('notifPhishingMessage', ['navigated', phishingRisk.sourceHost, normalizedHost])
    );

    return {
      status: 'phishing',
      host: normalizedHost,
      alert: true,
      highlightFields: true,
      sourceHost: phishingRisk.sourceHost,
      redirectChain: phishingRisk.redirectChain,
      reason: phishingRisk.reason
    };
  }

  // No referrer/history means user typed URL directly - this is SAFE behavior
  // Unknown host without suspicious navigation pattern - no alert needed
  console.log(`RTPS: Site ${normalizedHost} is unknown but no suspicious referrer pattern detected`);

  return {
    status: 'unknown',
    host: normalizedHost,
    alert: false,
    warning: false,
    highlightFields: false
  };
}

async function analyzePhishingRisk(tabId, currentHost, documentReferrer) {
  const history = tabNavigationHistory.get(tabId) || [];
  const settings = await getSettings();
  const maxLevels = settings.redirectLevels || 4;

  // Get the last N entries from history (redirect chain)
  const recentHistory = history.slice(-maxLevels);

  // Check if user typed the URL directly - if so, no cross-domain phishing risk
  const currentEntry = recentHistory[recentHistory.length - 1];
  if (currentEntry && currentEntry.isTypedDirectly) {
    console.log(`RTPS: User typed ${currentHost} directly - no phishing risk from redirects`);
    return { isHighRisk: false, reason: 'User typed URL directly' };
  }

  // Extract the referrer host from document.referrer
  let referrerHost = null;
  if (documentReferrer) {
    try {
      referrerHost = normalizeHost(new URL(documentReferrer).hostname);
    } catch (e) {
      // Invalid referrer URL
    }
  }

  // Build the redirect chain with transition info
  const redirectChain = recentHistory.map(entry => entry.host);
  const redirectChainDetailed = recentHistory.map(entry => ({
    host: entry.host,
    transitionType: entry.transitionType,
    isFromLink: entry.isFromLink,
    isRedirect: entry.isRedirect
  }));

  // Find the source domain (the first different domain in the chain)
  // Look for where the cross-domain navigation originated
  let sourceHost = null;
  let sourceEntry = null;
  for (let i = recentHistory.length - 1; i >= 0; i--) {
    const entry = recentHistory[i];
    if (!isSameDomain(entry.host, currentHost)) {
      sourceHost = entry.host;
      sourceEntry = entry;
      break;
    }
  }

  // If no source from history, try the referrer
  if (!sourceHost && referrerHost && !isSameDomain(referrerHost, currentHost)) {
    sourceHost = referrerHost;
  }

  // If there's no cross-domain navigation, no phishing risk from redirects
  if (!sourceHost) {
    return { isHighRisk: false };
  }

  // Check if the source domain is a known safe domain (like email providers)
  const sourceStatus = await checkHostStatus(sourceHost);

  // If the user came from a safe domain (like their email) to an unknown domain
  // that asks for password, this is HIGH RISK
  if (sourceStatus.isSafe) {
    // Determine how they arrived
    const navigationMethod = sourceEntry?.isFromLink ? 'clicked a link' :
                            sourceEntry?.isRedirect ? 'was redirected' :
                            currentEntry?.isFromLink ? 'clicked a link' : 'navigated';

    return {
      isHighRisk: true,
      sourceHost,
      redirectChain,
      redirectChainDetailed,
      navigationMethod,
      reason: `You ${navigationMethod} from trusted site "${sourceHost}" to unknown site "${currentHost}" which is asking for credentials.`
    };
  }

  // If source is also unknown but different domain, check for suspicious patterns
  if (!sourceStatus.isSafe && !sourceStatus.isUnsafe) {
    // Check if there are multiple redirects (suspicious)
    const uniqueHosts = [...new Set(redirectChain)];

    // Count actual redirects (server_redirect or client_redirect)
    const redirectCount = recentHistory.filter(e => e.isRedirect).length;

    if (uniqueHosts.length >= 3 || redirectCount >= 2) {
      return {
        isHighRisk: true,
        sourceHost: uniqueHosts[0],
        redirectChain,
        redirectChainDetailed,
        redirectCount,
        reason: `Multiple redirects detected through ${uniqueHosts.length} different domains (${redirectCount} redirects) before reaching a login page.`
      };
    }

    // Check for link-based cross-domain navigation (user clicked a link)
    // This is common in phishing emails that link to fake sites
    if (sourceEntry?.isFromLink || currentEntry?.isFromLink) {
      return {
        isHighRisk: true,
        sourceHost,
        redirectChain,
        redirectChainDetailed,
        navigationMethod: 'clicked a link',
        reason: `You clicked a link from "${sourceHost}" that led to unknown site "${currentHost}" which is asking for credentials.`
      };
    }
  }

  return {
    isHighRisk: false,
    sourceHost,
    redirectChain,
    redirectChainDetailed
  };
}

function isSameDomain(host1, host2) {
  if (!host1 || !host2) return false;

  // Exact match
  if (host1 === host2) return true;

  // Extract base domain (last two parts for most TLDs)
  const getBaseDomain = (host) => {
    const parts = host.split('.');
    if (parts.length <= 2) return host;

    // Handle special cases like .co.uk, .com.br, etc.
    const specialTLDs = ['co.uk', 'com.br', 'com.mx', 'com.ar', 'com.co', 'co.jp', 'co.kr', 'com.au'];
    const lastTwo = parts.slice(-2).join('.');
    if (specialTLDs.includes(lastTwo)) {
      return parts.slice(-3).join('.');
    }
    return parts.slice(-2).join('.');
  };

  return getBaseDomain(host1) === getBaseDomain(host2);
}

function getNavigationHistory(tabId) {
  return tabNavigationHistory.get(tabId) || [];
}

async function checkHostStatus(host) {
  const normalizedHost = normalizeHost(host);
  const storage = await browser.storage.local.get([STORAGE_KEYS.SAFE_HOSTS, STORAGE_KEYS.UNSAFE_HOSTS]);

  const safeHosts = storage[STORAGE_KEYS.SAFE_HOSTS] || [];
  const unsafeHosts = storage[STORAGE_KEYS.UNSAFE_HOSTS] || [];

  const isSafe = safeHosts.some(h => hostMatches(normalizedHost, h));
  const isUnsafe = unsafeHosts.some(h => hostMatches(normalizedHost, h));

  console.log(`RTPS: checkHostStatus("${normalizedHost}") -> isSafe: ${isSafe}, isUnsafe: ${isUnsafe}`);

  return { host: normalizedHost, isSafe, isUnsafe, isUnknown: !isSafe && !isUnsafe };
}

async function addHost(host, isSafe) {
  const normalizedHost = normalizeHost(host);
  const key = isSafe ? STORAGE_KEYS.SAFE_HOSTS : STORAGE_KEYS.UNSAFE_HOSTS;
  const otherKey = isSafe ? STORAGE_KEYS.UNSAFE_HOSTS : STORAGE_KEYS.SAFE_HOSTS;

  const storage = await browser.storage.local.get([key, otherKey]);
  const hosts = storage[key] || [];
  const otherHosts = storage[otherKey] || [];

  // Remove from other list if present
  const filteredOther = otherHosts.filter(h => h !== normalizedHost);

  // Add to list if not already present
  if (!hosts.includes(normalizedHost)) {
    hosts.push(normalizedHost);
  }

  await browser.storage.local.set({
    [key]: hosts,
    [otherKey]: filteredOther
  });

  // Remove from detected phishing if marking as safe
  if (isSafe) {
    await removeFromDetectedPhishing(normalizedHost);
  }

  return { success: true, host: normalizedHost, isSafe };
}

async function removeHost(host) {
  const normalizedHost = normalizeHost(host);

  const storage = await browser.storage.local.get([STORAGE_KEYS.SAFE_HOSTS, STORAGE_KEYS.UNSAFE_HOSTS]);
  const safeHosts = (storage[STORAGE_KEYS.SAFE_HOSTS] || []).filter(h => h !== normalizedHost);
  const unsafeHosts = (storage[STORAGE_KEYS.UNSAFE_HOSTS] || []).filter(h => h !== normalizedHost);

  await browser.storage.local.set({
    [STORAGE_KEYS.SAFE_HOSTS]: safeHosts,
    [STORAGE_KEYS.UNSAFE_HOSTS]: unsafeHosts
  });

  return { success: true, host: normalizedHost };
}

async function getAllHosts() {
  const storage = await browser.storage.local.get([STORAGE_KEYS.SAFE_HOSTS, STORAGE_KEYS.UNSAFE_HOSTS]);
  return {
    safeHosts: storage[STORAGE_KEYS.SAFE_HOSTS] || [],
    unsafeHosts: storage[STORAGE_KEYS.UNSAFE_HOSTS] || []
  };
}

async function getDetectedPhishing() {
  const storage = await browser.storage.local.get(STORAGE_KEYS.DETECTED_PHISHING);
  return storage[STORAGE_KEYS.DETECTED_PHISHING] || [];
}

async function clearDetectedPhishing() {
  await browser.storage.local.set({ [STORAGE_KEYS.DETECTED_PHISHING]: [] });
  return { success: true };
}

async function removeFromDetectedPhishing(host) {
  const detected = await getDetectedPhishing();
  const filtered = detected.filter(entry => normalizeHost(entry.host) !== host);
  await browser.storage.local.set({ [STORAGE_KEYS.DETECTED_PHISHING]: filtered });
}

async function getSettings() {
  const storage = await browser.storage.local.get(STORAGE_KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(storage[STORAGE_KEYS.SETTINGS] || {}) };
}

async function updateSettings(newSettings) {
  const currentSettings = await getSettings();
  const mergedSettings = { ...currentSettings, ...newSettings };
  await browser.storage.local.set({ [STORAGE_KEYS.SETTINGS]: mergedSettings });

  // Reload translations if language changed
  if (newSettings.language && newSettings.language !== cachedLanguage) {
    await loadBackgroundTranslations();
  }

  return { success: true, settings: mergedSettings };
}

// Helper functions
function normalizeHost(host) {
  if (!host) return '';
  // Remove www. prefix and convert to lowercase
  return host.toLowerCase().replace(/^www\./, '');
}

function hostMatches(testHost, storedHost) {
  // Exact match
  if (testHost === storedHost) return true;
  // Subdomain match (e.g., mail.google.com matches google.com)
  if (testHost.endsWith('.' + storedHost)) return true;
  return false;
}

async function updateBadge(tabId, status) {
  const colors = {
    safe: '#4CAF50',
    warning: '#FF9800',
    danger: '#F44336',
    default: '#607D8B'
  };

  const texts = {
    safe: '',
    warning: '!',
    danger: '!!',
    default: ''
  };

  try {
    await browser.action.setBadgeBackgroundColor({
      color: colors[status] || colors.default,
      tabId
    });
    await browser.action.setBadgeText({
      text: texts[status] || texts.default,
      tabId
    });
  } catch (error) {
    console.error('RTPS: Error updating badge', error);
  }
}

async function showNotification(title, message) {
  const settings = await getSettings();
  if (!settings.showNotifications) return;

  try {
    await browser.notifications.create({
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/icon-48.png'),
      title: `RTPS: ${title}`,
      message
    });
  } catch (error) {
    console.error('RTPS: Error showing notification', error);
  }
}

// Listen for tab updates to reset badge
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    updateBadge(tabId, 'default');
  }
});

console.log('RTPS: Background service worker loaded with referrer tracking');
