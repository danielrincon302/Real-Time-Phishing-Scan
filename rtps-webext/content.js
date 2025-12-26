// Real Time Phishing Scan - Content Script
// Detects password fields and communicates with background script for phishing detection

(function() {
  'use strict';

  // Prevent multiple initializations
  if (window.rtpsInitialized) return;
  window.rtpsInitialized = true;

  const RTPS = {
    warningInjected: false,
    passwordFieldsFound: [],
    currentStatus: null,
    scanTimeout: null,
    translations: {},
    currentLanguage: 'en'
  };

  // Load translations
  async function loadTranslations() {
    try {
      const settings = await browser.runtime.sendMessage({ action: 'GET_SETTINGS' });
      RTPS.currentLanguage = settings.language || 'en';
      console.log('RTPS: Loading translations for language:', RTPS.currentLanguage);

      const url = browser.runtime.getURL(`_locales/${RTPS.currentLanguage}/messages.json`);
      console.log('RTPS: Fetching translations from:', url);
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      RTPS.translations = await response.json();
      console.log('RTPS: Translations loaded successfully, keys:', Object.keys(RTPS.translations).length);
    } catch (error) {
      console.error('RTPS: Error loading translations:', error);
      // Fallback to English
      try {
        console.log('RTPS: Trying fallback to English...');
        const url = browser.runtime.getURL('_locales/en/messages.json');
        const response = await fetch(url);
        if (response.ok) {
          RTPS.translations = await response.json();
          console.log('RTPS: Fallback translations loaded');
        }
      } catch (e) {
        console.error('RTPS: Error loading fallback translations:', e);
        // Set hardcoded fallback translations
        RTPS.translations = getHardcodedFallback();
      }
    }
  }

  // Hardcoded fallback translations in case files can't be loaded
  function getHardcodedFallback() {
    return {
      phishingWarning: { message: 'PHISHING WARNING!' },
      phishingDetected: { message: 'PHISHING DETECTED!' },
      dangerKnownPhishing: { message: 'DANGER: Known Phishing Site!' },
      warningUnverifiedSite: { message: 'Warning: Unverified Site' },
      doNotEnterPassword: { message: 'This site has been marked as dangerous. DO NOT enter your password!' },
      clickedLinkFrom: {
        message: 'You clicked a link from "$SOURCE$" (trusted) to this unknown site which is now asking for your password. This is a common phishing pattern!',
        placeholders: { source: { content: '$1' } }
      },
      suspiciousNavigation: { message: 'Suspicious navigation pattern detected. Verify this is a legitimate site!' },
      unverifiedSiteMessage: { message: 'This site is asking for a password but is not in your trusted list. Verify this is legitimate before entering credentials.' },
      navigationPath: { message: 'Navigation path:' },
      trustThisSite: { message: 'I trust this site' },
      iUnderstandRisk: { message: 'I understand the risk' },
      dismiss: { message: 'Dismiss' },
      siteAddedToTrusted: { message: 'Site added to trusted list' },
      confirmDismissWarning: { message: 'Are you sure you want to dismiss this warning?\n\nThis site has been identified as potentially dangerous.' },
      rtpsWarningFocus: { message: 'RTPS WARNING: This appears to be a phishing site!\n\nDO NOT enter your password.\n\nIf you believe this is a legitimate site, you can add it to your trusted list in the RTPS extension.' }
    };
  }

  function getMessage(key, substitutions = []) {
    const message = RTPS.translations[key];
    if (!message) {
      console.warn('RTPS: Missing translation for key:', key);
      // Return from hardcoded fallback if available
      const fallback = getHardcodedFallback()[key];
      if (fallback) {
        return processMessage(fallback, substitutions);
      }
      return key;
    }

    return processMessage(message, substitutions);
  }

  function processMessage(message, substitutions) {
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

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  async function init() {
    // Load translations first
    await loadTranslations();

    // Initial scan for password fields
    scanForPasswordFields();

    // Observe DOM changes for dynamically added password fields
    observeDOMChanges();

    // Listen for click events that might reveal hidden password fields
    document.addEventListener('click', handleClick, true);

    // Also listen for focus events on inputs (some sites show password on focus)
    document.addEventListener('focusin', handleFocusIn, true);
  }


  function scanForPasswordFields() {
    // Debounce rapid scans
    if (RTPS.scanTimeout) {
      clearTimeout(RTPS.scanTimeout);
    }

    RTPS.scanTimeout = setTimeout(() => {
      performScan();
    }, 100);
  }

  function performScan() {
    const passwordInputs = document.querySelectorAll('input[type="password"]');

    if (passwordInputs.length > 0) {
      // Check if any password field is visible
      const visiblePasswordFields = Array.from(passwordInputs).filter(isElementVisible);

      if (visiblePasswordFields.length > 0) {
        notifyPasswordFieldDetected(visiblePasswordFields);
      }
    }
  }

  function observeDOMChanges() {
    const observer = new MutationObserver((mutations) => {
      let shouldScan = false;

      for (const mutation of mutations) {
        // Check added nodes
        if (mutation.addedNodes.length > 0) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              if (node.tagName === 'INPUT' && node.type === 'password') {
                shouldScan = true;
                break;
              }
              if (node.querySelector && node.querySelector('input[type="password"]')) {
                shouldScan = true;
                break;
              }
            }
          }
        }

        // Check attribute changes (type changed to password)
        if (mutation.type === 'attributes' && mutation.attributeName === 'type') {
          if (mutation.target.type === 'password') {
            shouldScan = true;
          }
        }

        // Check style/class changes that might reveal hidden password fields
        if (mutation.type === 'attributes' &&
            (mutation.attributeName === 'style' || mutation.attributeName === 'class')) {
          if (mutation.target.querySelector && mutation.target.querySelector('input[type="password"]')) {
            shouldScan = true;
          }
        }

        if (shouldScan) break;
      }

      if (shouldScan) {
        scanForPasswordFields();
      }
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['type', 'style', 'class', 'hidden']
    });
  }

  function handleClick(event) {
    // After click, check if new password fields appeared
    setTimeout(scanForPasswordFields, 300);
    setTimeout(scanForPasswordFields, 1000); // Check again after animations
  }

  function handleFocusIn(event) {
    // When focusing on form elements, check for password fields
    if (event.target.tagName === 'INPUT') {
      setTimeout(scanForPasswordFields, 200);
    }
  }

  async function notifyPasswordFieldDetected(passwordFields) {
    // Avoid duplicate notifications for same fields
    const newFields = passwordFields.filter(field => !RTPS.passwordFieldsFound.includes(field));

    if (newFields.length === 0) return;

    RTPS.passwordFieldsFound.push(...newFields);

    const data = {
      host: window.location.hostname,
      url: window.location.href,
      referrer: document.referrer || ''
    };

    try {
      const response = await browser.runtime.sendMessage({
        action: 'PASSWORD_FIELD_DETECTED',
        data
      });

      RTPS.currentStatus = response;

      // Handle different status responses
      if (response.status === 'safe') {
        // Site is safe, maybe show subtle indicator
        console.log('RTPS: Site is trusted:', response.host);
        return;
      }

      // Check if we need to highlight password fields (cross-domain detection)
      if (response.highlightFields) {
        // HIGH RISK - Show prominent warning and highlight fields in RED
        console.log('RTPS: Cross-domain phishing detected! Highlighting password fields.');
        injectWarning(newFields, 'danger', response);
        return;
      }

      if (response.status === 'phishing' || response.status === 'unsafe') {
        // HIGH RISK - Show prominent warning
        injectWarning(newFields, 'danger', response);
      } else if (response.status === 'unknown' && response.warning) {
        // Unknown site with suspicious referrer pattern - show moderate warning
        injectWarning(newFields, 'warning', response);
      } else if (response.status === 'unknown') {
        // Unknown site but user navigated directly (no suspicious referrer)
        // No warning needed - this is normal behavior
        console.log('RTPS: Unknown site but no suspicious navigation pattern. No warning.');
      }

    } catch (error) {
      console.error('RTPS: Error communicating with background script', error);
    }
  }

  function injectWarning(passwordFields, severity, response) {
    if (RTPS.warningInjected) return;

    const isDanger = severity === 'danger';
    const isPhishing = response.status === 'phishing';

    // Build warning message based on response
    let title, message;

    if (response.status === 'unsafe') {
      title = getMessage('dangerKnownPhishing');
      message = getMessage('doNotEnterPassword');
    } else if (isPhishing && response.sourceHost) {
      title = getMessage('phishingWarning');
      message = getMessage('clickedLinkFrom', [response.sourceHost]);
    } else if (isPhishing) {
      title = getMessage('phishingDetected');
      message = response.reason || getMessage('suspiciousNavigation');
    } else {
      title = getMessage('warningUnverifiedSite');
      message = getMessage('unverifiedSiteMessage');
    }

    // Get extension icon URL
    const logoUrl = browser.runtime.getURL('icons/full.png');

    // Create warning banner using safe DOM methods
    const banner = document.createElement('div');
    banner.id = 'rtps-warning-banner';

    const bannerContent = document.createElement('div');
    bannerContent.className = 'rtps-banner-content';

    // Logo section
    const logoDiv = document.createElement('div');
    logoDiv.className = 'rtps-banner-logo';
    const logoImg = document.createElement('img');
    logoImg.src = logoUrl;
    logoImg.alt = 'RTPS Logo';
    logoDiv.appendChild(logoImg);

    // Text section
    const textDiv = document.createElement('div');
    textDiv.className = 'rtps-banner-text';

    const titleDiv = document.createElement('div');
    titleDiv.className = 'rtps-banner-title';
    const titleStrong = document.createElement('strong');
    titleStrong.textContent = title;
    const warningIcon = document.createElement('span');
    warningIcon.className = 'rtps-warning-icon';
    warningIcon.textContent = '⚠';
    titleDiv.appendChild(titleStrong);
    titleDiv.appendChild(warningIcon);

    const messagePara = document.createElement('p');
    messagePara.textContent = message;

    textDiv.appendChild(titleDiv);
    textDiv.appendChild(messagePara);

    // Redirect chain (if exists)
    if (response.redirectChain && response.redirectChain.length > 0) {
      const chainDiv = document.createElement('div');
      chainDiv.className = 'rtps-redirect-chain';
      const chainSpan = document.createElement('span');
      chainSpan.textContent = getMessage('navigationPath') + ' ' + response.redirectChain.join(' → ') + ' →';
      const chainHost = document.createElement('strong');
      chainHost.textContent = response.host;
      chainDiv.appendChild(chainSpan);
      chainDiv.appendChild(chainHost);
      textDiv.appendChild(chainDiv);
    }

    // Actions section
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'rtps-banner-actions';

    if (!isDanger) {
      const trustButton = document.createElement('button');
      trustButton.id = 'rtps-trust-btn';
      trustButton.textContent = getMessage('trustThisSite');
      actionsDiv.appendChild(trustButton);
    }

    const dismissButton = document.createElement('button');
    dismissButton.id = 'rtps-dismiss-btn';
    dismissButton.textContent = isDanger ? getMessage('iUnderstandRisk') : getMessage('dismiss');
    actionsDiv.appendChild(dismissButton);

    // Assemble banner
    bannerContent.appendChild(logoDiv);
    bannerContent.appendChild(textDiv);
    bannerContent.appendChild(actionsDiv);
    banner.appendChild(bannerContent);

    // Inject styles
    const style = document.createElement('style');
    style.id = 'rtps-styles';
    style.textContent = `
      #rtps-warning-banner {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        z-index: 2147483647;
        background: ${isDanger ? 'linear-gradient(135deg, #C62828 0%, #B71C1C 100%)' : 'linear-gradient(135deg, #FF9800 0%, #F57C00 100%)'};
        color: white;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.4);
        animation: rtps-slide-down 0.3s ease-out;
      }
      @keyframes rtps-slide-down {
        from { transform: translateY(-100%); }
        to { transform: translateY(0); }
      }
      @keyframes rtps-slide-up {
        from { transform: translateY(0); }
        to { transform: translateY(-100%); }
      }
      .rtps-banner-content {
        max-width: 100%;
        margin: 0;
        padding: 12px 24px;
        display: flex;
        align-items: flex-start;
        gap: 16px;
      }
      .rtps-banner-logo {
        flex-shrink: 0;
        width: 96px;
        height: 96px;
      }
      .rtps-banner-logo img {
        width: 100%;
        height: 100%;
        object-fit: contain;
        filter: drop-shadow(2px 2px 4px rgba(0,0,0,0.3));
      }
      .rtps-banner-text {
        flex: 1;
        min-width: 250px;
      }
      .rtps-banner-title {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 4px;
      }
      .rtps-banner-title strong {
        font-size: 18px;
        font-weight: 700;
        letter-spacing: 0.5px;
      }
      .rtps-warning-icon {
        font-size: 22px;
        color: white;
        text-shadow: 1px 1px 2px rgba(0,0,0,0.3);
        animation: rtps-icon-pulse 1.5s ease-in-out infinite;
      }
      @keyframes rtps-icon-pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.7; transform: scale(1.1); }
      }
      .rtps-banner-text p {
        margin: 0 0 8px 0;
        color: white !important;
        opacity: 1;
        font-size: 13px;
        line-height: 1.4;
      }
      .rtps-redirect-chain {
        background: rgba(0,0,0,0.25);
        padding: 8px 12px;
        border-radius: 4px;
        font-family: 'Consolas', 'Monaco', monospace;
        font-size: 13px;
        display: inline-block;
      }
      .rtps-redirect-chain span {
        opacity: 0.9;
      }
      .rtps-redirect-chain strong {
        color: #FFD54F;
        font-weight: 700;
      }
      .rtps-banner-actions {
        display: flex;
        flex-direction: column;
        gap: 8px;
        flex-shrink: 0;
        align-self: center;
      }
      .rtps-banner-actions button {
        padding: 10px 20px;
        border: 2px solid white;
        border-radius: 6px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 600;
        transition: all 0.2s;
        white-space: nowrap;
      }
      #rtps-trust-btn {
        background: white;
        color: ${isDanger ? '#C62828' : '#E65100'};
      }
      #rtps-trust-btn:hover {
        background: rgba(255,255,255,0.9);
        transform: translateY(-1px);
      }
      #rtps-dismiss-btn {
        background: rgba(255,255,255,0.15);
        color: white;
        border-color: rgba(255,255,255,0.5);
      }
      #rtps-dismiss-btn:hover {
        background: rgba(255,255,255,0.25);
        border-color: white;
      }
      .rtps-password-warning {
        outline: 4px solid ${isDanger ? '#D32F2F' : '#FF9800'} !important;
        box-shadow: 0 0 20px ${isDanger ? 'rgba(211,47,47,0.6)' : 'rgba(255,152,0,0.6)'} !important;
        animation: rtps-input-pulse 2s infinite;
      }
      @keyframes rtps-input-pulse {
        0%, 100% { box-shadow: 0 0 20px ${isDanger ? 'rgba(211,47,47,0.6)' : 'rgba(255,152,0,0.6)'}; }
        50% { box-shadow: 0 0 30px ${isDanger ? 'rgba(211,47,47,0.8)' : 'rgba(255,152,0,0.8)'}; }
      }
    `;

    // Remove old styles if exist
    const oldStyle = document.getElementById('rtps-styles');
    if (oldStyle) oldStyle.remove();

    document.head.appendChild(style);
    document.body.insertBefore(banner, document.body.firstChild);

    // Add warning styles to password fields
    passwordFields.forEach(field => {
      field.classList.add('rtps-password-warning');

      // Add focus warning
      field.addEventListener('focus', () => {
        if (isDanger && !field.dataset.rtpsWarned) {
          field.dataset.rtpsWarned = 'true';
          alert(getMessage('rtpsWarningFocus'));
        }
      }, { once: true });
    });

    // Add event listeners
    const trustBtn = document.getElementById('rtps-trust-btn');
    const dismissBtn = document.getElementById('rtps-dismiss-btn');

    if (trustBtn) {
      trustBtn.addEventListener('click', async () => {
        try {
          await browser.runtime.sendMessage({
            action: 'ADD_SAFE_HOST',
            data: { host: window.location.hostname }
          });
          removeWarning(passwordFields);
          // Show confirmation
          showToast(getMessage('siteAddedToTrusted'));
        } catch (error) {
          console.error('RTPS: Error adding safe host', error);
        }
      });
    }

    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => {
        if (isDanger) {
          // For dangerous sites, require confirmation
          if (confirm(getMessage('confirmDismissWarning'))) {
            removeWarning(passwordFields);
          }
        } else {
          removeWarning(passwordFields);
        }
      });
    }

    RTPS.warningInjected = true;
  }

  function removeWarning(passwordFields) {
    const banner = document.getElementById('rtps-warning-banner');
    if (banner) {
      banner.style.animation = 'rtps-slide-up 0.3s ease-out forwards';
      setTimeout(() => banner.remove(), 300);
    }

    passwordFields.forEach(field => {
      field.classList.remove('rtps-password-warning');
    });

    RTPS.warningInjected = false;
  }

  function showToast(message) {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: #4CAF50;
      color: white;
      padding: 12px 24px;
      border-radius: 8px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      font-weight: 600;
      z-index: 2147483647;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      animation: rtps-toast-in 0.3s ease-out;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = 'rtps-toast-out 0.3s ease-out forwards';
      setTimeout(() => toast.remove(), 300);
    }, 2000);

    // Add toast animations
    const toastStyle = document.createElement('style');
    toastStyle.textContent = `
      @keyframes rtps-toast-in {
        from { opacity: 0; transform: translateX(-50%) translateY(20px); }
        to { opacity: 1; transform: translateX(-50%) translateY(0); }
      }
      @keyframes rtps-toast-out {
        from { opacity: 1; transform: translateX(-50%) translateY(0); }
        to { opacity: 0; transform: translateX(-50%) translateY(20px); }
      }
    `;
    document.head.appendChild(toastStyle);
  }

  function isElementVisible(element) {
    if (!element) return false;

    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }

    // Check if element or any parent has hidden attribute
    let current = element;
    while (current) {
      if (current.hidden) return false;
      current = current.parentElement;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return false;
    }

    return true;
  }

})();
