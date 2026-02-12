/**
 * Usion Mini App SDK v2.0
 * 
 * JavaScript utilities for Mini Apps (Iframe Games & Services)
 * Import via: <script src="https://your-domain/usion-sdk.js"></script>
 * 
 * Features:
 * - User info and authentication
 * - Persistent storage (per-user, per-service)
 * - Wallet/payment integration
 * - Session management
 * - Real-time game support via Socket.IO
 */

(function(global) {
  'use strict';

  // Request ID counter for tracking async responses
  let _requestId = 0;
  const _pendingRequests = {};

  const Usion = {
    version: '2.0.1',
    config: {},
    _initialized: false,
    _initCallback: null,
    _messageHandlerRegistered: false,

    /**
     * Initialize the SDK with config from parent app
     * @param {function} callback - Called with config when ready
     */
    init: function(callback) {
      const self = this;
      
      // Prevent double initialization - just update callback
      if (self._initialized) {
        if (callback) callback(self.config);
        return;
      }
      
      // Store callback for when config arrives
      self._initCallback = callback;
      
      // Only register message handler once
      if (self._messageHandlerRegistered) {
        return;
      }
      self._messageHandlerRegistered = true;
      
      // Setup global message handler
      window.addEventListener('message', function(event) {
        let data;
        try {
          data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        } catch (e) {
          return;
        }

        // Handle INIT message
        if (data.type === 'INIT' && data.config) {
          // Prevent double config - only set once
          if (self._initialized) {
            return;
          }
          
          self.config = data.config;
          self._initialized = true;
          // We received INIT from a parent → we are embedded (iframe or WebView)
          self._isEmbedded = true;
          
          // Initialize user module with config data
          if (data.config.userId) {
            self.user._id = data.config.userId;
            self.user._name = data.config.userName;
            self.user._avatar = data.config.userAvatar;
            self.user._token = data.config.authToken;
          }
          
          // Initialize session module
          if (data.config.sessionId) {
            self.session._id = data.config.sessionId;
            self.session._data = data.config.sessionData || {};
          }
          
          // Initialize wallet with balance if provided
          if (data.config.balance !== undefined) {
            self.wallet._balance = data.config.balance;
          }
          
          // Call the stored init callback
          if (self._initCallback) {
            self._initCallback(data.config);
          }
        }
        
        // Handle response messages for async requests
        if (data._requestId && _pendingRequests[data._requestId]) {
          const { resolve, reject } = _pendingRequests[data._requestId];
          delete _pendingRequests[data._requestId];
          
          if (data.error) {
            reject(new Error(data.error));
          } else {
            resolve(data);
          }
        }
        
        // Handle balance updates
        if (data.type === 'BALANCE_UPDATE') {
          self.wallet._balance = data.balance;
          if (self.wallet._balanceChangeHandler) {
            self.wallet._balanceChangeHandler(data.balance);
          }
        }
      });

      // Signal ready to parent
      this._post({ type: 'READY' });
    },

    /**
     * Send message to parent app
     * @private
     */
    _post: function(message) {
      const msg = JSON.stringify(message);
      
      // React Native WebView
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(msg);
        return;
      }
      
      // Web iframe
      if (window.parent !== window) {
        window.parent.postMessage(message, '*');
      }
    },

    /**
     * Send async request to parent and wait for response
     * @private
     */
    _request: function(type, data, timeout) {
      const self = this;
      timeout = timeout || 5000;
      
      return new Promise(function(resolve, reject) {
        const requestId = ++_requestId;
        
        // Setup timeout
        const timer = setTimeout(function() {
          delete _pendingRequests[requestId];
          reject(new Error('Request timeout'));
        }, timeout);
        
        // Store pending request
        _pendingRequests[requestId] = {
          resolve: function(result) {
            clearTimeout(timer);
            resolve(result);
          },
          reject: function(error) {
            clearTimeout(timer);
            reject(error);
          }
        };
        
        // Send request
        self._post({
          type: type,
          _requestId: requestId,
          ...data
        });
      });
    },

    // ============================================
    // User Module
    // ============================================

    /**
     * User information and authentication
     */
    user: {
      _id: null,
      _name: null,
      _avatar: null,
      _token: null,

      /**
       * Get the current user's ID
       * @returns {string|null}
       */
      getId: function() {
        return this._id || Usion.config.userId || null;
      },

      /**
       * Get the current user's display name
       * @returns {string|null}
       */
      getName: function() {
        return this._name || Usion.config.userName || null;
      },

      /**
       * Get the current user's avatar URL
       * @returns {string|null}
       */
      getAvatar: function() {
        return this._avatar || Usion.config.userAvatar || null;
      },

      /**
       * Get the user's auth token for socket connections
       * @returns {string|null}
       */
      getToken: function() {
        return this._token || Usion.config.authToken || null;
      },

      /**
       * Get full user profile
       * @returns {Promise<object>} User profile with id, name, avatar
       */
      getProfile: function() {
        return Usion._request('GET_USER_PROFILE', {}).then(function(response) {
          return response.profile || {
            id: Usion.user.getId(),
            name: Usion.user.getName(),
            avatar: Usion.user.getAvatar()
          };
        });
      }
    },

    // ============================================
    // Storage Module
    // ============================================

    /**
     * Persistent storage (per-user, per-service)
     */
    storage: {
      /**
       * Get a stored value
       * @param {string} key - Storage key
       * @returns {Promise<any>} Stored value or null
       */
      get: function(key) {
        return Usion._request('STORAGE_GET', { key: key }).then(function(response) {
          return response.value;
        });
      },

      /**
       * Set a stored value
       * @param {string} key - Storage key
       * @param {any} value - Value to store (will be JSON serialized)
       * @returns {Promise<void>}
       */
      set: function(key, value) {
        return Usion._request('STORAGE_SET', { key: key, value: value }).then(function() {
          return;
        });
      },

      /**
       * Remove a stored value
       * @param {string} key - Storage key
       * @returns {Promise<void>}
       */
      remove: function(key) {
        return Usion._request('STORAGE_REMOVE', { key: key }).then(function() {
          return;
        });
      },

      /**
       * Clear all stored values for this service
       * @returns {Promise<void>}
       */
      clear: function() {
        return Usion._request('STORAGE_CLEAR', {}).then(function() {
          return;
        });
      },

      /**
       * Get all keys
       * @returns {Promise<string[]>}
       */
      keys: function() {
        return Usion._request('STORAGE_KEYS', {}).then(function(response) {
          return response.keys || [];
        });
      }
    },

    // ============================================
    // Wallet Module
    // ============================================

    /**
     * Wallet and payment operations
     */
    wallet: {
      _balance: null,
      _balanceChangeHandler: null,

      /**
       * Get current wallet balance
       * @returns {Promise<number>} Balance in credits
       */
      getBalance: function() {
        const self = this;
        
        // If we have cached balance, return it
        if (self._balance !== null) {
          return Promise.resolve(self._balance);
        }
        
        return Usion._request('GET_BALANCE', {}).then(function(response) {
          self._balance = response.balance;
          return response.balance;
        });
      },

      /**
       * Check if user has enough credits
       * @param {number} amount - Amount to check
       * @returns {Promise<boolean>}
       */
      hasCredits: function(amount) {
        return this.getBalance().then(function(balance) {
          return balance >= amount;
        });
      },

      /**
       * Request payment from user with balance check
       * @param {number} amount - Credit amount to charge
       * @param {string} reason - Description shown to user
       * @param {object} data - Optional additional data
       * @returns {Promise} Resolves on payment success, rejects on failure
       */
      requestPayment: function(amount, reason, data) {
        const self = this;
        
        return new Promise(function(resolve, reject) {
          const requestId = ++_requestId;
          const timeoutMs = 60000;

          // Listen for response
          function handler(event) {
            let response;
            try {
              response = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
            } catch (e) {
              return;
            }

            // Only accept responses for this specific payment request.
            if (response._requestId !== requestId) {
              return;
            }

            if (response.type === 'PAYMENT_SUCCESS') {
              clearTimeout(timer);
              window.removeEventListener('message', handler);
              // Update cached balance
              if (response.newBalance !== undefined) {
                self._balance = response.newBalance;
              } else if (self._balance !== null) {
                self._balance -= amount;
              }
              resolve(response);
            } else if (response.type === 'PAYMENT_FAILED') {
              clearTimeout(timer);
              window.removeEventListener('message', handler);
              reject(new Error(response.reason || 'Payment failed'));
            }
          }

          window.addEventListener('message', handler);
          const timer = setTimeout(function() {
            window.removeEventListener('message', handler);
            reject(new Error('Payment confirmation timeout'));
          }, timeoutMs);

          // Send payment request
          Usion._post({
            type: 'PAYMENT_REQUEST',
            _requestId: requestId,
            amount: amount,
            reason: reason,
            data: data
          });
        });
      },

      /**
       * Listen for balance changes
       * @param {function} callback - Called with new balance
       */
      onBalanceChange: function(callback) {
        this._balanceChangeHandler = callback;
      }
    },

    // ============================================
    // Session Module
    // ============================================

    /**
     * Session management (ephemeral data for current session)
     */
    session: {
      _id: null,
      _data: {},

      /**
       * Get the current session ID
       * @returns {string|null}
       */
      getId: function() {
        return this._id || Usion.config.sessionId || null;
      },

      /**
       * Get session data
       * @param {string} key - Optional key to get specific value
       * @returns {any} Session data or specific value
       */
      getData: function(key) {
        if (key) {
          return this._data[key];
        }
        return this._data;
      },

      /**
       * Set session data (ephemeral, cleared on session end)
       * @param {string|object} keyOrData - Key or object of data to set
       * @param {any} value - Value if key is string
       */
      setData: function(keyOrData, value) {
        if (typeof keyOrData === 'object') {
          Object.assign(this._data, keyOrData);
        } else {
          this._data[keyOrData] = value;
        }
        
        // Notify parent of session data change
        Usion._post({
          type: 'SESSION_DATA_UPDATE',
          data: this._data
        });
      },

      /**
       * Clear session data
       */
      clear: function() {
        this._data = {};
        Usion._post({
          type: 'SESSION_DATA_CLEAR'
        });
      }
    },

    // ============================================
    // Legacy Payment Method (for backwards compatibility)
    // ============================================

    /**
     * Request payment from user (legacy method)
     * @deprecated Use Usion.wallet.requestPayment instead
     */
    requestPayment: function(amount, reason, data) {
      return this.wallet.requestPayment(amount, reason, data);
    },

    /**
     * Submit result and signal completion
     * @param {object} data - Result data to send to parent
     */
    submit: function(data) {
      this._post({
        type: 'SUBMIT',
        data: data
      });
    },

    /**
     * Report an error to parent app
     * @param {string} message - Error message
     */
    error: function(message) {
      this._post({
        type: 'ERROR',
        message: message
      });
    },

    /**
     * Request to close the mini app
     */
    exit: function() {
      this._post({ type: 'EXIT' });
    },

    /**
     * Share content through the app's native share and optionally post to Usions feed
     * 
     * @param {string} contentType - Type of content: 'audio' | 'image' | 'video' | 'text' | 'mixed'
     * @param {object} data - Content data to share:
     *   - text: Optional text/caption for the post
     *   - audioUrl: URL for audio content (when contentType is 'audio')
     *   - imageUrl: URL for image content (when contentType is 'image')
     *   - videoUrl: URL for video content (when contentType is 'video')
     *   - thumbnailUrl: Optional thumbnail URL for video/audio
     *   - width: Optional width for image/video
     *   - height: Optional height for image/video
     *   - duration: Optional duration in seconds for audio/video
     *   - media: Array of media items for 'mixed' content type
     *     - Each item: { type: 'image'|'video'|'audio', url: string, thumbnailUrl?, width?, height?, duration? }
     * 
     * @example
     * // Share audio
     * Usion.share('audio', { 
     *   text: 'Check out this AI voice!', 
     *   audioUrl: 'https://cdn.example.com/audio.mp3',
     *   duration: 5.2
     * });
     * 
     * @example
     * // Share image
     * Usion.share('image', { 
     *   text: 'AI-generated art', 
     *   imageUrl: 'https://cdn.example.com/image.webp',
     *   thumbnailUrl: 'https://cdn.example.com/thumb.webp',
     *   width: 1024,
     *   height: 1024
     * });
     * 
     * @example
     * // Share video
     * Usion.share('video', {
     *   text: 'My AI video creation',
     *   videoUrl: 'https://cdn.example.com/video.mp4',
     *   thumbnailUrl: 'https://cdn.example.com/poster.jpg',
     *   duration: 30
     * });
     * 
     * @example
     * // Share mixed content (multiple media)
     * Usion.share('mixed', {
     *   text: 'Gallery of AI creations',
     *   media: [
     *     { type: 'image', url: 'https://cdn.example.com/1.webp' },
     *     { type: 'image', url: 'https://cdn.example.com/2.webp' },
     *     { type: 'video', url: 'https://cdn.example.com/video.mp4', thumbnailUrl: '...' }
     *   ]
     * });
     */
    share: function(contentType, data) {
      var shareData = Object.assign({}, data, {
        contentType: contentType,
        serviceId: this.config.serviceId,
        serviceName: this.config.serviceName
      });
      
      this._post({
        type: 'SHARE',
        contentType: contentType,
        data: shareData
      });
    },

    /**
     * Log message to native console (for debugging)
     * @param {string} msg - Message to log
     */
    log: function(msg) {
      this._post({
        type: 'LOG',
        msg: msg
      });
      console.log('[Usion]', msg);
    },

    /**
     * Listen for messages from parent app
     * @param {string} type - Message type to listen for
     * @param {function} callback - Handler function
     */
    on: function(type, callback) {
      window.addEventListener('message', function(event) {
        let data;
        try {
          data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        } catch (e) {
          return;
        }

        if (data.type === type) {
          callback(data);
        }
      });
    },

    // ============================================
    // UI Utilities
    // ============================================

    /**
     * Set button to loading state
     * @param {HTMLElement|string} btn - Button element or selector
     * @param {boolean} loading - Whether to show loading state
     */
    setLoading: function(btn, loading) {
      const el = typeof btn === 'string' ? document.querySelector(btn) : btn;
      if (!el) return;

      if (loading) {
        el.classList.add('usion-btn-loading');
        el.disabled = true;
        el.dataset.originalText = el.textContent;
      } else {
        el.classList.remove('usion-btn-loading');
        el.disabled = false;
        if (el.dataset.originalText) {
          el.textContent = el.dataset.originalText;
        }
      }
    },

    /**
     * Show/hide an element
     * @param {HTMLElement|string} el - Element or selector
     * @param {boolean} show - Whether to show or hide
     */
    toggle: function(el, show) {
      const element = typeof el === 'string' ? document.querySelector(el) : el;
      if (!element) return;

      if (show) {
        element.classList.remove('usion-hidden', 'hidden');
        element.classList.add('usion-visible');
      } else {
        element.classList.add('usion-hidden');
        element.classList.remove('usion-visible');
      }
    },

    /**
     * Update character count display
     * @param {HTMLElement|string} input - Input element or selector
     * @param {HTMLElement|string} counter - Counter element or selector
     * @param {number} max - Maximum characters
     */
    charCount: function(input, counter, max) {
      const inputEl = typeof input === 'string' ? document.querySelector(input) : input;
      const counterEl = typeof counter === 'string' ? document.querySelector(counter) : counter;
      
      if (!inputEl || !counterEl) return;

      function update() {
        const count = inputEl.value.length;
        counterEl.textContent = count + ' / ' + max;
        
        counterEl.classList.remove('warning', 'error');
        if (count > max * 0.9) {
          counterEl.classList.add('error');
        } else if (count > max * 0.7) {
          counterEl.classList.add('warning');
        }
      }

      inputEl.addEventListener('input', update);
      update();
    },

    /**
     * Create a selection handler for grid items
     * @param {string} containerSelector - Container selector
     * @param {string} itemSelector - Item selector
     * @param {function} onChange - Callback when selection changes
     */
    selectionGrid: function(containerSelector, itemSelector, onChange) {
      const container = document.querySelector(containerSelector);
      if (!container) return;

      let selected = null;

      container.querySelectorAll(itemSelector).forEach(function(item) {
        item.addEventListener('click', function() {
          // Remove selection from all
          container.querySelectorAll(itemSelector).forEach(function(i) {
            i.classList.remove('selected');
          });
          
          // Select this one
          item.classList.add('selected');
          selected = item.dataset.value || item.dataset.id;
          
          if (onChange) onChange(selected, item);
        });
      });

      return {
        getSelected: function() { return selected; },
        clear: function() {
          container.querySelectorAll(itemSelector).forEach(function(i) {
            i.classList.remove('selected');
          });
          selected = null;
        }
      };
    },

    // ============================================
    // Game/Multiplayer Utilities
    // ============================================

    /**
     * Game module for multiplayer real-time games
     */
    game: {
      socket: null,
      directSocket: null,
      roomId: null,
      playerId: null,
      connected: false,
      directMode: false,
      directConfig: null,
      _directSeq: 0,
      _eventHandlers: {},
      _lastSequence: 0,
      _connecting: false,
      _connectPromise: null,
      _joined: false,
      _joinPromise: null,
      _lastJoinedPayload: null,
      _directJoinResolve: null,
      _directJoinReject: null,
      _directJoinTimeout: null,
      _useProxy: false,
      _proxyListenerSetup: false,

      /**
       * Connect to the game socket server
       * @param {string} socketUrl - Socket.IO server URL (optional, uses config)
       * @param {string} token - JWT auth token (optional, uses user.getToken())
       * @returns {Promise} Resolves when connected
       */
      connect: function(socketUrl, token) {
        const self = this;
        var connectionMode = (Usion.config && Usion.config.connectionMode) || 'platform';
        if (connectionMode === 'direct') {
          return self.connectDirect();
        }
        
        // Use config values as defaults
        socketUrl = socketUrl || Usion.config.socketUrl;
        token = token || Usion.user.getToken();
        
        if (!socketUrl) {
          return Promise.reject(new Error('No socket URL provided'));
        }
        if (!token) {
          return Promise.reject(new Error('No auth token available'));
        }
        
        // If already connected (direct or proxy), return immediately
        if (self._useProxy && self.connected) {
          return Promise.resolve();
        }
        if (self.socket && self.connected) {
          return Promise.resolve();
        }
        
        // If currently connecting, return the existing promise
        if (self._connecting && self._connectPromise) {
          return self._connectPromise;
        }
        
        // When running inside an iframe or WebView, always use the parent app
        // as a socket proxy. The parent already has an authenticated socket
        // connection, avoids CORS issues, and avoids mixed-content blocks.
        // Detection order (first truthy wins):
        //   (1) __USION_PROXY__ injected by parent before page load (most reliable)
        //   (2) iframe check (window.parent !== window)
        //   (3) ReactNativeWebView global
        //   (4) _isEmbedded flag set when INIT message was received
        var isInFrame = !!window.__USION_PROXY__
                     || window.parent !== window
                     || !!window.ReactNativeWebView
                     || !!Usion._isEmbedded;
        
        if (isInFrame) {
          Usion.log('Running in iframe – using parent app as socket proxy');
          return self._connectViaProxy();
        }
        
        self._connecting = true;
        self._connectPromise = new Promise(function(resolve, reject) {
          // Check if socket.io-client is available
          if (typeof io === 'undefined') {
            // Load socket.io client – try local copy first, fallback to CDN
            var script = document.createElement('script');
            script.src = '/socket.io.min.js';
            script.onload = function() {
              self._initSocket(socketUrl, token, resolve, reject);
            };
            script.onerror = function() {
              // Local file not available, try CDN as fallback
              var cdnScript = document.createElement('script');
              cdnScript.src = 'https://cdn.socket.io/4.7.2/socket.io.min.js';
              cdnScript.onload = function() {
                self._initSocket(socketUrl, token, resolve, reject);
              };
              cdnScript.onerror = function() {
                self._connecting = false;
                reject(new Error('Failed to load Socket.IO client'));
              };
              document.head.appendChild(cdnScript);
            };
            document.head.appendChild(script);
          } else {
            self._initSocket(socketUrl, token, resolve, reject);
          }
        });
        
        return self._connectPromise;
      },

      /**
       * Connect directly to creator-controlled WebSocket server.
       * Uses backend-issued short-lived room token.
       * @returns {Promise}
       */
      connectDirect: function(config) {
        var self = this;
        config = config || {};

        if (self.directMode && self.directSocket && self.connected) {
          return Promise.resolve();
        }
        if (self._connecting && self._connectPromise) {
          return self._connectPromise;
        }

        self._connecting = true;
        self.directMode = true;
        self._connectPromise = self._fetchDirectAccess(config)
          .then(function(access) {
            self.directConfig = access;
            return self._initDirectSocket(access);
          })
          .then(function() {
            self.connected = true;
            self._connecting = false;
            Usion.log('Direct game socket connected');
          })
          .catch(function(err) {
            self._connecting = false;
            self.connected = false;
            self.directMode = false;
            if (self._eventHandlers.connectionError) {
              self._eventHandlers.connectionError(err);
            }
            throw err;
          });
        return self._connectPromise;
      },

      _fetchDirectAccess: function(config) {
        var roomId = config.roomId || this.roomId || Usion.config.roomId;
        var serviceId = config.serviceId || Usion.config.serviceId;
        var apiUrl = config.apiUrl || Usion.config.apiUrl || '';
        var token = config.token || Usion.user.getToken();

        if (!roomId) return Promise.reject(new Error('No room ID provided'));
        if (!serviceId) return Promise.reject(new Error('No service ID provided'));
        if (!apiUrl) return Promise.reject(new Error('No API URL provided'));
        if (!token) return Promise.reject(new Error('No auth token available'));

        this.roomId = roomId;
        this.playerId = Usion.user.getId();

        var cleanApiUrl = String(apiUrl).replace(/\/$/, '');
        var accessEndpoint = cleanApiUrl + '/games/rooms/' + encodeURIComponent(roomId) + '/access';
        var joinEndpoint = cleanApiUrl + '/games/rooms/' + encodeURIComponent(roomId) + '/join';
        var authHeaders = {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        };
        var accessBody = JSON.stringify({
          service_id: serviceId,
          client_type: 'iframe',
          protocol_version: (config.protocolVersion || Usion.config.protocolVersion || Usion.config.protocol_version || '2')
        });

        function requestAccess() {
          return fetch(accessEndpoint, {
            method: 'POST',
            headers: authHeaders,
            body: accessBody
          }).then(function(res) {
            if (!res.ok) {
              return res.text().then(function(text) {
                throw { status: res.status, message: text || ('Direct access failed: HTTP ' + res.status) };
              });
            }
            return res.json();
          });
        }

        // First try to get access token directly
        return requestAccess().catch(function(err) {
          // If user is not a participant (403), auto-join the room first, then retry
          if (err && err.status === 403) {
            Usion.log('Not a room participant, auto-joining...');
            return fetch(joinEndpoint, {
              method: 'POST',
              headers: authHeaders
            }).then(function(joinRes) {
              if (!joinRes.ok) {
                return joinRes.text().then(function(text) {
                  throw new Error(text || ('Room join failed: HTTP ' + joinRes.status));
                });
              }
              Usion.log('Auto-joined room, requesting access token...');
              return requestAccess();
            });
          }
          throw new Error(err.message || String(err));
        });
      },

      _initDirectSocket: function(access) {
        var self = this;
        return new Promise(function(resolve, reject) {
          if (!access || !access.ws_url || !access.access_token) {
            reject(new Error('Invalid direct access payload'));
            return;
          }

          var wsUrl = access.ws_url;
          var separator = wsUrl.indexOf('?') === -1 ? '?' : '&';
          var urlWithToken = wsUrl + separator + 'token=' + encodeURIComponent(access.access_token);
          var openedAtMs = Date.now();
          try {
            var parsedWsUrl = new URL(wsUrl);
            console.log('[SDK] Opening direct WS', {
              host: parsedWsUrl.host,
              path: parsedWsUrl.pathname,
              room_id: access.room_id || Usion.config.roomId || null,
              session_id: access.session_id || null,
              protocol_version: access.protocol_version || null
            });
          } catch (e) {
            console.log('[SDK] Opening direct WS', { ws_url: wsUrl });
          }
          var ws = new WebSocket(urlWithToken);
          self.directSocket = ws;

          var opened = false;
          var timeout = setTimeout(function() {
            if (!opened) {
              try { ws.close(); } catch (e) {}
              reject(new Error('Direct WebSocket connection timeout'));
            }
          }, 10000);

          ws.onopen = function() {
            opened = true;
            clearTimeout(timeout);
            console.log('[SDK] WebSocket onopen fired', {
              readyState: ws.readyState,
              elapsed_ms: Date.now() - openedAtMs,
              online: typeof navigator !== 'undefined' ? navigator.onLine : null,
              visibility: typeof document !== 'undefined' ? document.visibilityState : null
            });
            resolve();
          };

          ws.onerror = function(evt) {
            console.log('[SDK] WebSocket onerror', {
              readyState: ws.readyState,
              elapsed_ms: Date.now() - openedAtMs,
              event_type: evt && evt.type ? evt.type : '(unknown)'
            });
            if (!opened) {
              clearTimeout(timeout);
              reject(new Error('Direct WebSocket connection error'));
            }
          };

          ws.onclose = function(evt) {
            console.log('[SDK] WebSocket onclose', {
              code: evt && evt.code !== undefined ? evt.code : null,
              reason: evt && evt.reason ? evt.reason : '',
              wasClean: evt && evt.wasClean !== undefined ? evt.wasClean : null,
              readyState: ws.readyState,
              elapsed_ms: Date.now() - openedAtMs
            });
            self.connected = false;
            self._joined = false;
            self._joinPromise = null;
            self._lastJoinedPayload = null;
            if (self._directJoinTimeout) {
              clearTimeout(self._directJoinTimeout);
              self._directJoinTimeout = null;
            }
            if (self._directJoinReject) {
              var code = evt && evt.code !== undefined ? evt.code : 'unknown';
              var reason = evt && evt.reason ? evt.reason : '';
              self._directJoinReject(new Error('direct socket closed before join completed (code=' + code + (reason ? ', reason=' + reason : '') + ')'));
            }
            self._directJoinResolve = null;
            self._directJoinReject = null;
            if (self._eventHandlers.disconnect) {
              self._eventHandlers.disconnect(evt && evt.reason ? evt.reason : 'direct socket closed');
            }
          };

          ws.onmessage = function(evt) {
            try {
              var frame = evt && evt.data ? JSON.parse(evt.data) : null;
              if (frame && frame.type && frame.type !== 'state_delta' && frame.type !== 'state_snapshot') {
                console.log('[SDK] WebSocket onmessage', {
                  type: frame.type,
                  readyState: ws.readyState,
                  elapsed_ms: Date.now() - openedAtMs
                });
              }
            } catch (e) {}
            self._handleDirectMessage(evt && evt.data);
          };
        });
      },

      _sendDirect: function(type, payload) {
        if (!this.directSocket || this.directSocket.readyState !== WebSocket.OPEN) {
          console.log(`[SDK] _sendDirect FAILED: type=${type} socket_state=${this.directSocket ? this.directSocket.readyState : 'null'}`);
          return;
        }
        this._directSeq = this._directSeq + 1;
        const msg = {
          type: type,
          room_id: this.roomId,
          ts: Date.now(),
          seq: this._directSeq,
          session_id: (this.directConfig && this.directConfig.session_id) ? this.directConfig.session_id : null,
          protocol_version: (this.directConfig && this.directConfig.protocol_version) ? this.directConfig.protocol_version : '2',
          payload: payload || {}
        };
        console.log(`[SDK] _sendDirect: type=${type} seq=${this._directSeq}`, msg);
        this.directSocket.send(JSON.stringify(msg));
      },

      _handleDirectMessage: function(raw) {
        var data;
        try {
          data = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch (e) {
          return;
        }
        if (!data || !data.type) return;
        var payload = data.payload || {};

        if (data.type === 'joined') {
          this._joined = true;
          this._lastJoinedPayload = payload;
          if (this._directJoinTimeout) {
            clearTimeout(this._directJoinTimeout);
            this._directJoinTimeout = null;
          }
          if (this._directJoinResolve) {
            this._directJoinResolve(payload);
            this._directJoinResolve = null;
            this._directJoinReject = null;
          }
          if (this._eventHandlers.joined) this._eventHandlers.joined(payload);
          return;
        }
        if (data.type === 'player_joined') {
          if (this._eventHandlers.playerJoined) this._eventHandlers.playerJoined(payload);
          return;
        }
        if (data.type === 'player_left') {
          if (this._eventHandlers.playerLeft) this._eventHandlers.playerLeft(payload);
          return;
        }
        if (data.type === 'game_start') {
          if (this._eventHandlers.gameStart) this._eventHandlers.gameStart(payload);
          // Also fire as realtime so frontend can catch it
          if (this._eventHandlers.realtime) this._eventHandlers.realtime({ type: 'game_start', payload: payload });
          return;
        }
        if (data.type === 'state_snapshot' || data.type === 'state_delta') {
          if (this._eventHandlers.realtime) this._eventHandlers.realtime(payload);
          if (this._eventHandlers.stateUpdate) this._eventHandlers.stateUpdate(payload);
          return;
        }
        if (data.type === 'pong') {
          if (this._eventHandlers.sync) this._eventHandlers.sync(payload);
          return;
        }
        if (data.type === 'match_end') {
          if (this._eventHandlers.finished) this._eventHandlers.finished(payload);
          return;
        }
        if (data.type === 'error') {
          if (this._directJoinTimeout) {
            clearTimeout(this._directJoinTimeout);
            this._directJoinTimeout = null;
          }
          if (this._directJoinReject) {
            this._directJoinReject(new Error(payload && (payload.message || payload.code) ? (payload.message || payload.code) : 'Direct join failed'));
            this._directJoinResolve = null;
            this._directJoinReject = null;
          }
          if (this._eventHandlers.error) this._eventHandlers.error(payload);
        }
      },

      /**
       * Initialize socket connection
       * @private
       */
      _initSocket: function(socketUrl, token, resolve, reject) {
        const self = this;
        
        // Prevent creating duplicate sockets
        if (self.socket && self.socket.connected) {
          self._connecting = false;
          resolve();
          return;
        }
        
        // Clean up any existing disconnected socket
        if (self.socket) {
          self.socket.disconnect();
          self.socket = null;
        }
        
        try {
          self.socket = io(socketUrl, {
            path: '/socket.io',
            transports: ['websocket', 'polling'],
            auth: { token: token },
            autoConnect: true,
            reconnection: true,
            reconnectionAttempts: 10,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000
          });

          self.socket.on('connect', function() {
            self.connected = true;
            self._connecting = false;
            Usion.log('Game socket connected');
            
            // Re-join room after reconnect so this socket gets room broadcasts again
            if (self.roomId) {
              self._joined = false;
              self._joinPromise = null;
              self.join(self.roomId)
                .then(function() {
                  Usion.log('Reconnected - joined room ' + self.roomId);
                  self.requestSync(self._lastSequence || 0);
                })
                .catch(function(err) {
                  Usion.log('Rejoin failed: ' + (err && err.message ? err.message : String(err)));
                });
            }
            
            resolve();
          });

          self.socket.on('connect_error', function(err) {
            self._connecting = false;
            Usion.log('Game socket error: ' + err.message);
            if (self._eventHandlers.connectionError) {
              self._eventHandlers.connectionError(err);
            }
            reject(err);
          });

          self.socket.on('disconnect', function(reason) {
            self.connected = false;
            self._joined = false;
            self._joinPromise = null;
            Usion.log('Game socket disconnected: ' + reason);
            if (self._eventHandlers.disconnect) {
              self._eventHandlers.disconnect(reason);
            }
          });

          self.socket.on('reconnect', function(attemptNumber) {
            Usion.log('Game socket reconnected after ' + attemptNumber + ' attempts');
            if (self._eventHandlers.reconnect) {
              self._eventHandlers.reconnect(attemptNumber);
            }
          });

          // Game event handlers
          self.socket.on('game:joined', function(data) {
            if (data.sequence !== undefined) {
              self._lastSequence = data.sequence;
            }
            if (self._eventHandlers.joined) {
              self._eventHandlers.joined(data);
            }
          });

          self.socket.on('game:player_joined', function(data) {
            if (self._eventHandlers.playerJoined) {
              self._eventHandlers.playerJoined(data);
            }
          });

          self.socket.on('game:player_left', function(data) {
            if (self._eventHandlers.playerLeft) {
              self._eventHandlers.playerLeft(data);
            }
          });

          self.socket.on('game:state', function(data) {
            if (data.sequence !== undefined) {
              self._lastSequence = Math.max(self._lastSequence, data.sequence);
            }
            if (self._eventHandlers.stateUpdate) {
              self._eventHandlers.stateUpdate(data);
            }
          });

          self.socket.on('game:sync', function(data) {
            if (data.sequence !== undefined) {
              self._lastSequence = data.sequence;
            }
            if (self._eventHandlers.sync) {
              self._eventHandlers.sync(data);
            }
            // Also trigger stateUpdate for backwards compat
            if (self._eventHandlers.stateUpdate) {
              self._eventHandlers.stateUpdate(data);
            }
          });

          self.socket.on('game:action', function(data) {
            if (data.sequence !== undefined) {
              self._lastSequence = Math.max(self._lastSequence, data.sequence);
            }
            if (self._eventHandlers.action) {
              self._eventHandlers.action(data);
            }
          });

          self.socket.on('game:realtime', function(data) {
            if (self._eventHandlers.realtime) {
              self._eventHandlers.realtime(data);
            }
          });

          self.socket.on('game:finished', function(data) {
            if (data.sequence !== undefined) {
              self._lastSequence = data.sequence;
            }
            if (self._eventHandlers.finished) {
              self._eventHandlers.finished(data);
            }
          });

          self.socket.on('game:error', function(data) {
            Usion.log('Game error: ' + (data.message || data.code));
            if (self._eventHandlers.error) {
              self._eventHandlers.error(data);
            }
          });

          self.socket.on('game:rematch_request', function(data) {
            if (self._eventHandlers.rematchRequest) {
              self._eventHandlers.rematchRequest(data);
            }
          });

          self.socket.on('game:restarted', function(data) {
            self._lastSequence = 0; // Reset sequence on rematch
            if (self._eventHandlers.restarted) {
              self._eventHandlers.restarted(data);
            }
          });

        } catch (err) {
          reject(err);
        }
      },

      /**
       * Connect via parent app proxy (postMessage relay).
       * Used when mixed content prevents direct socket connection.
       * @private
       */
      _connectViaProxy: function() {
        var self = this;
        
        if (self._useProxy && self.connected) {
          return Promise.resolve();
        }
        
        self._useProxy = true;
        self._connecting = true;
        self._setupProxyListener();
        
        self._connectPromise = new Promise(function(resolve, reject) {
          // Listen for GAME_CONNECTED from parent
          self._proxyConnectResolve = function() {
            self.connected = true;
            self._connecting = false;
            Usion.log('Game socket connected via parent proxy');
            resolve();
          };
          
          // Send connect request to parent
          Usion._post({ type: 'GAME_CONNECT' });
          
          // Timeout after 10s
          setTimeout(function() {
            if (!self.connected) {
              self._connecting = false;
              reject(new Error('Proxy connection timeout'));
            }
          }, 10000);
        });
        
        return self._connectPromise;
      },

      /**
       * Set up message listener for proxy game events from parent.
       * @private
       */
      _setupProxyListener: function() {
        var self = this;
        if (self._proxyListenerSetup) return;
        self._proxyListenerSetup = true;
        
        window.addEventListener('message', function(event) {
          var data;
          try {
            data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
          } catch (e) {
            return;
          }
          if (!data || typeof data !== 'object' || !self._useProxy) return;
          
          switch (data.type) {
            case 'GAME_CONNECTED':
              if (self._proxyConnectResolve) {
                self._proxyConnectResolve();
                self._proxyConnectResolve = null;
              }
              break;
              
            case 'GAME_CONNECT_ERROR':
              self.connected = false;
              self._connecting = false;
              break;
              
            case 'GAME_JOINED':
              self._joined = true;
              if (data.sequence !== undefined) self._lastSequence = data.sequence;
              if (self._proxyJoinResolve) {
                self._proxyJoinResolve(data);
                self._proxyJoinResolve = null;
              }
              if (self._eventHandlers.joined) self._eventHandlers.joined(data);
              break;
              
            case 'GAME_JOIN_ERROR':
              self._joined = false;
              if (self._proxyJoinReject) {
                self._proxyJoinReject(new Error(data.message || 'Join failed'));
                self._proxyJoinReject = null;
              }
              break;
              
            case 'GAME_PLAYER_JOINED':
              if (self._eventHandlers.playerJoined) self._eventHandlers.playerJoined(data);
              break;
              
            case 'GAME_PLAYER_LEFT':
              if (self._eventHandlers.playerLeft) self._eventHandlers.playerLeft(data);
              break;
              
            case 'GAME_STATE':
              if (data.sequence !== undefined) self._lastSequence = Math.max(self._lastSequence, data.sequence);
              if (self._eventHandlers.stateUpdate) self._eventHandlers.stateUpdate(data);
              break;
              
            case 'GAME_ACTION_DATA':
              if (data.sequence !== undefined) self._lastSequence = Math.max(self._lastSequence, data.sequence);
              if (self._eventHandlers.action) self._eventHandlers.action(data);
              break;
              
            case 'GAME_REALTIME_DATA':
              if (self._eventHandlers.realtime) self._eventHandlers.realtime(data);
              break;
              
            case 'GAME_FINISHED':
              if (data.sequence !== undefined) self._lastSequence = data.sequence;
              if (self._eventHandlers.finished) self._eventHandlers.finished(data);
              break;
              
            case 'GAME_ERROR':
              Usion.log('Game error via proxy: ' + (data.message || data.code));
              if (self._eventHandlers.error) self._eventHandlers.error(data);
              break;
              
            case 'GAME_RESTARTED':
              self._lastSequence = 0;
              if (self._eventHandlers.restarted) self._eventHandlers.restarted(data);
              break;
              
            case 'GAME_REMATCH_REQUEST':
              if (self._eventHandlers.rematchRequest) self._eventHandlers.rematchRequest(data);
              break;
              
            case 'GAME_SYNC':
              if (data.sequence !== undefined) self._lastSequence = data.sequence;
              if (self._eventHandlers.sync) self._eventHandlers.sync(data);
              if (self._eventHandlers.stateUpdate) self._eventHandlers.stateUpdate(data);
              break;
          }
        });
      },

      /**
       * Join a game room
       * @param {string} roomId - Game room ID (optional, uses config)
       * @returns {Promise} Resolves with join data
       */
      join: function(roomId) {
        const self = this;
        roomId = roomId || Usion.config.roomId;
        
        // If already joined this room, return cached promise/data
        if (self._joined && self.roomId === roomId && self._joinPromise) {
          return self._joinPromise;
        }
        
        self.roomId = roomId;
        self.playerId = Usion.user.getId();

        if (self.directMode) {
          if (!self.directSocket || self.directSocket.readyState !== WebSocket.OPEN || !self.connected) {
            return Promise.reject(new Error('Not connected'));
          }

          if (self._joined && self.roomId === roomId && self._lastJoinedPayload) {
            self._joinPromise = Promise.resolve(self._lastJoinedPayload);
            return self._joinPromise;
          }

          self._joinPromise = new Promise(function(resolve, reject) {
            self._directJoinResolve = function(payload) {
              resolve(payload || {
                room_id: roomId,
                player_id: self.playerId
              });
            };
            self._directJoinReject = function(err) {
              self._joined = false;
              self._joinPromise = null;
              reject(err);
            };
            if (self._directJoinTimeout) clearTimeout(self._directJoinTimeout);
            self._directJoinTimeout = setTimeout(function() {
              self._directJoinTimeout = null;
              if (self._directJoinReject) {
                self._directJoinReject(new Error('Join timeout'));
                self._directJoinResolve = null;
                self._directJoinReject = null;
              }
            }, 15000);
            if (!self._joined) self._sendDirect('join', {});
          });
          return self._joinPromise;
        }

        // Proxy mode: send join request to parent
        if (self._useProxy) {
          self._joinPromise = new Promise(function(resolve, reject) {
            self._proxyJoinResolve = resolve;
            self._proxyJoinReject = reject;
            Usion._post({ type: 'GAME_JOIN', room_id: roomId });
            setTimeout(function() {
              if (!self._joined && self._proxyJoinReject) {
                self._proxyJoinReject = null;
                reject(new Error('Join timeout'));
              }
            }, 15000);
          });
          return self._joinPromise;
        }

        self._joinPromise = new Promise(function(resolve, reject) {
          if (!self.socket || !self.connected) {
            reject(new Error('Not connected'));
            return;
          }

          if (!roomId) {
            reject(new Error('No room ID provided'));
            return;
          }

          self.socket.emit('game:join', { room_id: roomId }, function(response) {
            if (response.error) {
              self._joined = false;
              reject(new Error(response.message || response.error));
            } else {
              self._joined = true;
              if (response.sequence !== undefined) {
                self._lastSequence = response.sequence;
              }
              resolve(response);
            }
          });
        });
        
        return self._joinPromise;
      },

      /**
       * Leave the current game room
       */
      leave: function() {
        const self = this;

        if (self.directMode) {
          if (self.roomId) self._sendDirect('leave', {});
          self.roomId = null;
          self._lastSequence = 0;
          self._joined = false;
          self._joinPromise = null;
          self._lastJoinedPayload = null;
          if (self._directJoinTimeout) {
            clearTimeout(self._directJoinTimeout);
            self._directJoinTimeout = null;
          }
          self._directJoinResolve = null;
          self._directJoinReject = null;
          return;
        }
        
        if (self._useProxy) {
          if (self.roomId) Usion._post({ type: 'GAME_LEAVE', room_id: self.roomId });
          self.roomId = null;
          self._lastSequence = 0;
          self._joined = false;
          self._joinPromise = null;
          return;
        }
        
        if (self.socket && self.connected && self.roomId) {
          self.socket.emit('game:leave', { room_id: self.roomId });
          self.roomId = null;
          self._lastSequence = 0;
          self._joined = false;
          self._joinPromise = null;
        }
      },

      /**
       * Send a game action
       * @param {string} actionType - Type of action (e.g., 'move')
       * @param {object} actionData - Action data
       * @returns {Promise} Resolves when action is processed
       */
      action: function(actionType, actionData) {
        const self = this;

        if (self.directMode) {
          self._sendDirect(actionType || 'action', actionData || {});
          return Promise.resolve({ success: true });
        }

        if (self._useProxy) {
          Usion._post({ type: 'GAME_ACTION', room_id: self.roomId, action_type: actionType, action_data: actionData });
          return Promise.resolve({ success: true });
        }

        return new Promise(function(resolve, reject) {
          if (!self.socket || !self.connected) {
            reject(new Error('Not connected'));
            return;
          }

          self.socket.emit('game:action', {
            room_id: self.roomId,
            action_type: actionType,
            action_data: actionData
          }, function(response) {
            if (response.error) {
              reject(new Error(response.message || response.error));
            } else {
              if (response.sequence !== undefined) {
                self._lastSequence = response.sequence;
              }
              resolve(response);
            }
          });
        });
      },

      /**
       * Send a real-time game update (no locking, no rate limiting, fire-and-forget).
       * Use this for high-frequency updates like position, input, state broadcasts.
       * @param {string} actionType - Type of action (e.g., 'snake_input', 'position')
       * @param {object} actionData - Action data
       */
      realtime: function(actionType, actionData) {
        const self = this;

        if (self.directMode) {
          self._sendDirect('input', {
            action_type: actionType,
            action_data: actionData || {}
          });
          return;
        }

        if (self._useProxy) {
          Usion._post({ type: 'GAME_REALTIME', room_id: self.roomId, action_type: actionType, action_data: actionData });
          return;
        }

        if (!self.socket || !self.connected) {
          return;
        }

        self.socket.emit('game:realtime', {
          room_id: self.roomId,
          action_type: actionType,
          action_data: actionData
        });
      },

      /**
       * Request game state sync (for reconnection)
       * @param {number} lastSequence - Last known sequence number
       */
      requestSync: function(lastSequence) {
        const self = this;
        lastSequence = lastSequence !== undefined ? lastSequence : self._lastSequence;

        if (self.directMode) {
          self._sendDirect('ping', { last_sequence: lastSequence || 0 });
          return;
        }
        
        if (self._useProxy && self.roomId) {
          Usion._post({ type: 'GAME_SYNC_REQUEST', room_id: self.roomId, last_sequence: lastSequence || 0 });
          return;
        }
        
        if (self.socket && self.connected && self.roomId) {
          self.socket.emit('game:sync_request', {
            room_id: self.roomId,
            last_sequence: lastSequence || 0
          });
        }
      },

      /**
       * Request a rematch
       */
      requestRematch: function() {
        const self = this;

        if (self.directMode) {
          self._sendDirect('rematch', {});
          return;
        }
        
        if (self._useProxy && self.roomId) {
          Usion._post({ type: 'GAME_REMATCH', room_id: self.roomId });
          return;
        }
        
        if (self.socket && self.connected && self.roomId) {
          self.socket.emit('game:rematch', { room_id: self.roomId });
        }
      },

      /**
       * Forfeit the current game
       * @returns {Promise}
       */
      forfeit: function() {
        const self = this;

        if (self.directMode) {
          self._sendDirect('forfeit', {});
          return Promise.resolve({ success: true });
        }

        if (self._useProxy) {
          Usion._post({ type: 'GAME_FORFEIT', room_id: self.roomId });
          return Promise.resolve({ success: true });
        }

        return new Promise(function(resolve, reject) {
          if (!self.socket || !self.connected) {
            reject(new Error('Not connected'));
            return;
          }

          self.socket.emit('game:forfeit', { room_id: self.roomId }, function(response) {
            if (response.error) {
              reject(new Error(response.message || response.error));
            } else {
              resolve(response);
            }
          });
        });
      },

      /**
       * Disconnect from the game socket
       */
      disconnect: function() {
        const self = this;

        if (self.directMode) {
          if (self.directSocket) {
            try { self.directSocket.close(); } catch (e) {}
          }
          self.directSocket = null;
          self.connected = false;
          self.roomId = null;
          self._lastSequence = 0;
          self._connecting = false;
          self._connectPromise = null;
          self._joined = false;
          self._joinPromise = null;
          self._lastJoinedPayload = null;
          if (self._directJoinTimeout) {
            clearTimeout(self._directJoinTimeout);
            self._directJoinTimeout = null;
          }
          self._directJoinResolve = null;
          self._directJoinReject = null;
          self.directMode = false;
          self.directConfig = null;
          self._directSeq = 0;
          return;
        }
        
        if (self._useProxy) {
          Usion._post({ type: 'GAME_DISCONNECT' });
          self.connected = false;
          self.roomId = null;
          self._lastSequence = 0;
          self._connecting = false;
          self._connectPromise = null;
          self._joined = false;
          self._joinPromise = null;
          self._useProxy = false;
          return;
        }
        
        if (self.socket) {
          self.socket.disconnect();
          self.socket = null;
          self.connected = false;
          self.roomId = null;
          self._lastSequence = 0;
          self._connecting = false;
          self._connectPromise = null;
          self._joined = false;
          self._joinPromise = null;
        }
      },

      /**
       * Get connection status
       * @returns {boolean}
       */
      isConnected: function() {
        if (this.directMode) {
          return this.connected && this.directSocket && this.directSocket.readyState === WebSocket.OPEN;
        }
        // Proxy mode: no direct socket, connected flag is sufficient
        if (this._useProxy) {
          return this.connected;
        }
        return this.connected && this.socket && this.socket.connected;
      },

      // Event handler registrations
      onJoined: function(callback) {
        this._eventHandlers.joined = callback;
      },

      onPlayerJoined: function(callback) {
        this._eventHandlers.playerJoined = callback;
      },

      onGameStart: function(callback) {
        this._eventHandlers.gameStart = callback;
      },

      onPlayerLeft: function(callback) {
        this._eventHandlers.playerLeft = callback;
      },

      onStateUpdate: function(callback) {
        this._eventHandlers.stateUpdate = callback;
      },

      onSync: function(callback) {
        this._eventHandlers.sync = callback;
      },

      onAction: function(callback) {
        this._eventHandlers.action = callback;
      },

      onRealtime: function(callback) {
        this._eventHandlers.realtime = callback;
      },

      onGameFinished: function(callback) {
        this._eventHandlers.finished = callback;
      },

      onGameRestarted: function(callback) {
        this._eventHandlers.restarted = callback;
      },

      onError: function(callback) {
        this._eventHandlers.error = callback;
      },

      onRematchRequest: function(callback) {
        this._eventHandlers.rematchRequest = callback;
      },

      onDisconnect: function(callback) {
        this._eventHandlers.disconnect = callback;
      },

      onReconnect: function(callback) {
        this._eventHandlers.reconnect = callback;
      },

      onConnectionError: function(callback) {
        this._eventHandlers.connectionError = callback;
      },

      /**
       * Register a generic event handler
       * @param {string} event - Event name
       * @param {function} callback - Handler function
       */
      on: function(event, callback) {
        if (this.socket) {
          this.socket.on(event, callback);
        }
      }
    }
  };

  // Expose to global
  global.Usion = Usion;

})(typeof window !== 'undefined' ? window : this);
