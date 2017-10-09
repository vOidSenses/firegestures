////////////////////////////////////////////////////////////////
// global

const Cc = Components.classes;
const Ci = Components.interfaces;

const PREFS_DOMAIN = "extensions.firegestures.";
const HTML_NS = "http://www.w3.org/1999/xhtml";

const STATE_READY    = 0;
const STATE_GESTURE  = 1;
const STATE_ROCKER   = 2;
const STATE_WHEEL    = 3;
const STATE_KEYPRESS = 4;

Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");

// #debug-begin
function log(aMsg) {
	dump("GestureHandler> " + aMsg + "\n");
}

function alert(aMsg) {
	Components.utils.reportError(aMsg);
}

const PLATFORM = Cc["@mozilla.org/system-info;1"].getService(Ci.nsIPropertyBag2).getProperty("name");
// #debug-end


////////////////////////////////////////////////////////////////
// xdGestureHandler

function xdGestureHandler() {}


xdGestureHandler.prototype = {

	// XPCOM registration info
	classDescription: "Mouse Gesture Handler",
	contractID: "@xuldev.org/firegestures/handler;1",
	classID: Components.ID("{ca559550-8ab4-41c5-a72f-fd931322cc7e}"),
	QueryInterface: XPCOMUtils.generateQI([
		Ci.nsISupports,
		Ci.nsIObserver,
		Ci.nsISupportsWeakReference,
		Ci.nsIDOMEventListener,
		Ci.nsITimerCallback,
		Ci.xdIGestureHandler
	]),

	// DOM element at the starting point of gesture
	sourceNode: null,

	// DOM element where user can perform gesture
	_drawArea: null,

	// last position of an on-screen mouse pointer
	_lastX: null,
	_lastY: null,

	// minimum distance (in px) required for a gesture node to register
	_deadzone: 7,

	// number of consecutive nodes (multiples of _deadzone) required
	// to add a direction to the chain
	_minNodes: 2,

	// require this chain (of length _minChain-1) be one direction only
	// to absorb unintentional movements
	_nodesChain: "",

	// current direction chain e.g. LRLRUDUD
	_directionChain: "",

	// nsITimer to handle gesture timeout
	_gestureTimer: null,

	// nsITimer to handle swipe gesture
	_swipeTimer: null,

	// xdIGestureObserver
	_gestureObserver: null,

	// [e10s] a flag to indicate whether the current browser is remote or not
	_isRemote: false,

	attach: function FGH_attach(aDrawArea, aObserver) {
		var appInfo = Cc["@mozilla.org/xre/app-info;1"].getService(Ci.nsIXULAppInfo);
		this._drawArea = aDrawArea;
		this._gestureObserver = aObserver;
		this._drawArea.addEventListener("mousedown", this, true);
		var root = this._drawArea.ownerDocument.defaultView.document.documentElement;
		root.addEventListener("mousemove", this, true);
		root.addEventListener("mouseup", this, true);
		this._drawArea.addEventListener("contextmenu", this, true);
		this._drawArea.addEventListener("dragstart", this, true);
		this._reloadPrefs();
		var prefBranch2 = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch2);
		prefBranch2.addObserver(PREFS_DOMAIN, this, true);
		// log("attach(" + aDrawArea + ", " + aObserver + ")");	// #debug
	},

	detach: function FGH_detach() {
		this._drawArea.removeEventListener("mousedown", this, true);
		var root = this._drawArea.ownerDocument.defaultView.document.documentElement;
		root.removeEventListener("mousemove", this, true);
		root.removeEventListener("mouseup", this, true);
		this._drawArea.removeEventListener("contextmenu", this, true);
		this._drawArea.removeEventListener("dragstart", this, true);
		var prefBranch2 = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch2);
		prefBranch2.removeObserver(PREFS_DOMAIN, this);
		this._clearTimeout();
		if (this._swipeTimer) {
			this._swipeTimer.cancel();
			this._swipeTimer = null;
		}
		this.sourceNode = null;
		this._drawArea = null;
		this._trailArea = null;
		this._trailContext = null;
		this._gestureObserver = null;
		// log("detach()");	// #debug
	},

	// called from init, observe
	_reloadPrefs: function FGH__reloadPrefs() {
		var prefBranch = Cc["@mozilla.org/preferences-service;1"]
		                 .getService(Ci.nsIPrefService)
		                 .getBranch(PREFS_DOMAIN);
		// @see nsSessionStore.js
		var getPref = function(aName) {
			try {
				switch (prefBranch.getPrefType(aName)) {
					case prefBranch.PREF_STRING:
						return prefBranch.getCharPref(aName);
					case prefBranch.PREF_BOOL:
						return prefBranch.getBoolPref(aName);
					case prefBranch.PREF_INT:
						return prefBranch.getIntPref(aName);
					default:
						throw null;
				}
			}
			catch(ex) {
				alert("Assertion failed!\ngetPref(" + aName + ")\n" + ex);	// #debug
			}
		};
		this._triggerButton  = getPref("trigger_button");
		this._suppressAlt    = getPref("suppress.alt");
		this._useDiagonals   = getPref("usediagonals");
		this._trailEnabled   = getPref("mousetrail");
		this._trailSize      = getPref("mousetrail.size");
		this._trailColor     = getPref("mousetrail.color");
		this._gestureTimeout = getPref("gesture_timeout");
		this._swipeTimeout   = getPref("swipe_timeout");
		this._mouseGestureEnabled    = getPref("mousegesture");
		this._wheelGestureEnabled    = getPref("wheelgesture");
		this._rockerGestureEnabled   = getPref("rockergesture");
		this._keypressGestureEnabled = getPref("keypressgesture");
		this._swipeGestureEnabled    = getPref("swipegesture");
		// prefs for wheel gestures and rocker gestures
		this._drawArea.removeEventListener("DOMMouseScroll", this, true);
		this._drawArea.removeEventListener("click", this, true);
		if (this._wheelGestureEnabled)
			this._drawArea.addEventListener("DOMMouseScroll", this, true);
		if (this._rockerGestureEnabled)
			this._drawArea.addEventListener("click", this, true);
		// prefs for tab wheel gesture
		if (this._drawArea.localName == "tabbrowser") {
			this._drawArea.tabContainer.removeEventListener("wheel", this._wheelOnTabBar, true);
			if (getPref("tabwheelgesture"))
				this._drawArea.tabContainer.addEventListener("wheel", this._wheelOnTabBar, true);
		}
		// if trigger button is middle, disable loading the clipboard URL with middle click.
		if (this._triggerButton == 1) {
			var prefSvc = Cc["@mozilla.org/preferences-service;1"]
			              .getService(Ci.nsIPrefBranch2)
			              .QueryInterface(Ci.nsIPrefService);
			prefSvc.setBoolPref("middlemouse.contentLoadURL", false);
			// alert("middlemouse.contentLoadURL has been changed.");	// #debug
		}
		// prefs for swipe gesture
		// add event listener to window in order to support swipe on browser chrome and Panorama
		var win = this._drawArea.ownerDocument.defaultView;
		win.removeEventListener("MozSwipeGesture", this, true);
		if (this._swipeGestureEnabled)
			win.addEventListener("MozSwipeGesture", this, true);
		// XXXreloading prefs is not a kind of gesture, but we can use it to communicate with xul window.
		this._gestureObserver.onExtraGesture(null, "reload-prefs");
		// log("_reloadPrefs");	// #debug
	},

	_state: STATE_READY,
	_isMouseDownL: false,
	_isMouseDownM: false,
	_isMouseDownR: false,
	_suppressContext: false,
	_shouldFireContext: false,	// [Linux]

	handleEvent: function FGH_handleEvent(event) {
		switch (event.type) {
			case "mousedown": 
				if (!this._gestureObserver.canStartGesture(event))
					break;
				if (event.button == 0) {
					if (this._triggerButton == 0) {
						// suppress starting gesture with left-button on HTML/XUL form elements
						var localName = event.target.localName;
						if (["input", "textarea", "select", "option", "textbox", "menulist"].indexOf(localName) >= 0) {
							log("*** suppress starting gesture on form element (" + localName + ")");	// #debug
							break;
						}
						// suppress starting gesture with left-button on scrollbar
						var localName = event.originalTarget.localName;
						if (["scrollbarbutton", "slider", "thumb"].indexOf(localName) >= 0) {
							log("*** suppress starting gesture on scrollbar (" + localName + ")");	// #debug
							break;
						}
					}
					this._isMouseDownL = true;
					this._isMouseDownM = false;	// fixed invalid state of _isMouseDownM after autoscrolling
					// any gestures with left-button - start
					if (this._triggerButton == 0 && !this._isMouseDownM && !this._isMouseDownR && !this._altKey(event)) {
						this._state = STATE_GESTURE;
						this._startGesture(event);
						// prevent selecting (only if mouse gesture is enabled)
						// [e10s] don't prevent in remote mode since event.target always becomes to xul:tabbrowser
						if (!this._isRemote && this._mouseGestureEnabled)
							event.preventDefault();
					}
					// rocker gesture
					else if (this._rockerGestureEnabled && this._isMouseDownR) {
						this._state = STATE_ROCKER;
						this._invokeExtraGesture(event, "rocker-left");
					}
				}
				else if (event.button == 1) {
					this._isMouseDownM = true;
					// any gestures with middle-button - start
					if (this._triggerButton == 1 && !this._isMouseDownL && !this._isMouseDownR && !this._altKey(event)) {
						this._state = STATE_GESTURE;
						this._startGesture(event);
					}
				}
				else if (event.button == 2) {
					// this fixes the problem: when showing context menu of a Flash movie, 
					// _isMouseDownR becomes true and then rocker-left will be fired with a left-click
					var localName = event.target.localName;
					if (localName == "object" || localName == "embed") {
						log("*** ignore right-click on flash movie (" + localName + ")");	// #debug
						break;
					}
					this._isMouseDownR = true;
					this._isMouseDownM = false;	// fixed invalid state of _isMouseDownM after autoscrolling
					this._suppressContext = false;	// only time to reset _suppressContext flag
					this._enableContextMenu(true);
					// any gestures with right-button - start
					if (this._triggerButton == 2 && !this._isMouseDownL && !this._isMouseDownM && !this._altKey(event)) {
						this._state = STATE_GESTURE;
						this._startGesture(event);
					}
					// rocker gesture
					else if (this._rockerGestureEnabled && this._isMouseDownL) {
						this._state = STATE_ROCKER;
						this._invokeExtraGesture(event, "rocker-right");
					}
				}
				break;
			case "mousemove": 
				if (this._state == STATE_GESTURE || this._state == STATE_KEYPRESS) {
					if (this._mouseGestureEnabled) {
						// keypress gesture
						if (this._keypressGestureEnabled && (event.ctrlKey || event.metaKey || event.shiftKey)) {
							var type = this._state == STATE_GESTURE ? "keypress-start" : "keypress-progress";
							this._state = STATE_KEYPRESS;
							this._invokeExtraGesture(event, type);
						}
						// mouse gesture
						this._progressGesture(event);
						// cancel auto-scroll if trigger button is middle
						if (this._triggerButton == 1 && this._isMouseDownM && 
						    this._drawArea.mCurrentBrowser._autoScrollPopup) {
							this._drawArea.mCurrentBrowser._autoScrollPopup.hidePopup();
						}
					}
				}
				else if (this._state == STATE_WHEEL || this._state == STATE_ROCKER) {
					// stop wheel gesture / rocker gesture when moving
					this._lastX = event.screenX;
					this._lastY = event.screenY;
					// #debug-begin
					var dx = this._lastX - this._lastExtraX;
					var dy = this._lastY - this._lastExtraY;
					log("moving in extra gesture: " + dx + " / " + dy);
					// #debug-end
					if (Math.abs(this._lastX - this._lastExtraX) > 10 || 
					    Math.abs(this._lastY - this._lastExtraY) > 10) {
						log("*** escape from " + (this._state == STATE_WHEEL ? "wheel gesture" : "rocker gesture"));	// #debug
						this._stopGesture();
					}
				}
				break;
			case "mouseup": 
				if (event.button == 0)
					this._isMouseDownL = false;
				else if (event.button == 1)
					this._isMouseDownM = false;
				else if (event.button == 2)
					this._isMouseDownR = false;
				// need additional | && this._state != STATE_READY| condition?
				if (!this._isMouseDownL && !this._isMouseDownM && !this._isMouseDownR) {
					// keypress gesture
					if (this._state == STATE_KEYPRESS) {
						this._state = STATE_READY;
						if (event.ctrlKey || event.metaKey)
							this._invokeExtraGesture(event, "keypress-ctrl");
						else if (event.shiftKey)
							this._invokeExtraGesture(event, "keypress-shift");
						this._invokeExtraGesture(event, "keypress-stop");
					}
					// any gestures - stop
					this._stopGesture(event);
					// [Linux][Mac] display context menu artificially
					if (this._shouldFireContext) {
						this._shouldFireContext = false;
						this._enableContextMenu(true);
						// synthesize contextmenu event by nsIDOMWindowUtils
						var win = this._drawArea.ownerDocument.defaultView;
						var x = event.screenX - win.document.documentElement.boxObject.screenX;
						var y = event.screenY - win.document.documentElement.boxObject.screenY;
						win.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIDOMWindowUtils).
						    sendMouseEvent("contextmenu", x, y, 2, 1, null);
						log("*** synthesize contextmenu event (" + x + ", " + y + ")");	// #debug
					}
				}
				break;
			case "contextmenu": 
				// [Linux] if right-click without holding left-button, display context menu artificially
				if (!this._isMouseDownL && this._isMouseDownR) {
					// #debug-begin
					if (PLATFORM == "Windows_NT")
						alert("Assertion failed!\ndisplay context menu artificially");
					// #debug-end
					this._suppressContext = true;
					this._shouldFireContext = true;
				}
				// enable context menu if contextmenu event is fired by Application key.
				if (event.button == 0) {
					log("*** contextmenu with Application key");	// #debug
					this._enableContextMenu(true);
				}
				if (this._suppressContext) {
					this._suppressContext = false;
					event.preventDefault();
					event.stopPropagation();
					this._enableContextMenu(false);
				}
				break;
			case "DOMMouseScroll": 
				// mouse geture > wheel gesture / wheel gesture > wheel gesture
				if (this._state == STATE_GESTURE || this._state == STATE_WHEEL) {
					this._state = STATE_WHEEL;
					this._invokeExtraGesture(event, event.detail < 0 ? "wheel-up" : "wheel-down");
					// suppress page scroll
					event.preventDefault();
					// required to suppress page scroll if using SmoothWheel or Yet Another Smooth Scrolling
					event.stopPropagation();
				}
				break;
			case "click": 
				// this fixes the bug: performing rocker-left on a link causes visiting the link
				// need 'if (this._isMouseDownL || this._isMouseDownR)' condition?
				if (this._state == STATE_ROCKER) {
					event.preventDefault();
					event.stopPropagation();
				}
				break;
			case "dragstart": 
				// this fixes the bug: _isMouseDownL remains true after drag-and-drop if...
				// STATE_READY  : trigger_button is right and mousegesture is enabled
				// STATE_GESTURE: trigger_button is left  and mousegesture is disabled
				// STATE_ROCKER : except dragstart events which are fired while sequential rocker-right
				if (this._state != STATE_ROCKER)
					this._isMouseDownL = false;
				break;
			case "MozSwipeGesture": 
				event.preventDefault();
				if (this._state != STATE_READY)
					return;
				// single swipe gesture
				if (this._swipeTimeout == 0) {
					var direction;
					switch (event.direction) {
						case event.DIRECTION_LEFT : direction = "left";  break;
						case event.DIRECTION_RIGHT: direction = "right"; break;
						case event.DIRECTION_UP   : direction = "up";    break;
						case event.DIRECTION_DOWN : direction = "down";  break;
					}
					this._isRemote = this._drawArea.mCurrentBrowser.getAttribute("remote") == "true";
					// [e10s] get source node and invoke extra gesture in remote
					if (this._isRemote) {
						var zoom = this._drawArea.mCurrentBrowser.fullZoom;
						this._gestureObserver.sendAsyncMessage("FireGestures:SwipeGesture", {
							direction: direction, 
							x: (event.screenX - this._drawArea.mCurrentBrowser.boxObject.screenX) / zoom, 
							y: (event.screenY - this._drawArea.mCurrentBrowser.boxObject.screenY) / zoom, 
						});
						return;
					}
					this.sourceNode = event.target;
					this._invokeExtraGesture(event, "swipe-" + direction);
					this.sourceNode = null;
					return;
				}
				// continuous swipe gesture
				if (this._swipeTimer) {
					this._swipeTimer.cancel();
					this._swipeTimer = null;
				}
				this._swipeTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
				this._swipeTimer.initWithCallback(this, this._swipeTimeout, Ci.nsITimer.TYPE_ONE_SHOT);
				if (!this._directionChain) {
					this._startGesture(event);
				}
				var direction;
				switch (event.direction) {
					case event.DIRECTION_LEFT : direction = "L"; break;
					case event.DIRECTION_RIGHT: direction = "R"; break;
					case event.DIRECTION_UP   : direction = "U"; break;
					case event.DIRECTION_DOWN : direction = "D"; break;
				}
				var lastDirection = this._directionChain.charAt(this._directionChain.length - 1);
				if (direction != lastDirection) {
					this._directionChain += direction;
					this._gestureObserver.onDirectionChanged(event, this._directionChain);
				}
				break;
		}
		// #debug-begin
		if (event.type == "mousemove" && !this._isMouseDownL && !this._isMouseDownM && !this._isMouseDownR)
			return;
		log(
			(event.type + "    ").substr(0, 9) + "  " + 
			(this._isMouseDownL ? "L" : "_") + 
			(this._isMouseDownM ? "M" : "_") + 
			(this._isMouseDownR ? "R" : "_") + " " + 
			event.button + " (" + this._state + ") "+ (this._suppressContext ? "*" : "") + " [" + 
			this._directionChain + "]"
		);
		// #debug-end
	},

	_altKey: function(event) {
		return this._suppressAlt ? event.altKey : false;
	},

	_enableContextMenu: function FGH__enableContextMenu(aEnable) {
		// If 'dom.event.contextmenu.enabled' is false,
		// there is a problem that context menu is not suppressed
		// by preventDefault and stopPropagation for DOM contextmenu event.
		// So, we should set hidden="true" attribute temporarily.
		var elt = this._drawArea.ownerDocument.getElementById("contentAreaContextMenu");
		if (!elt)
			elt = this._drawArea.ownerDocument.getElementById("viewSourceContextMenu");
		if (!elt)
			return;
		if (aEnable)
			elt.removeAttribute("hidden");
		else
			elt.setAttribute("hidden", "true");
	},

	_wheelOnTabBar: function FGH__wheelOnTabBar(event) {
		var tabbar = null;
		if (event.target.localName == "tab")
			tabbar = event.target.parentNode;
		else if (event.target.localName == "tabs" && event.originalTarget.localName != "menuitem")
			tabbar = event.target;
		else
			return;
		event.preventDefault();
		event.stopPropagation();
		tabbar.advanceSelectedTab(event.deltaY < 0 ? -1 : 1, true);
	},

	// called from handleEvent (type is "mousedown", "MozSwipeGesture")
	_startGesture: function FGH__startGesture(event) {
		if (this._drawArea.localName == "tabbrowser")
			this._isRemote = this._drawArea.mCurrentBrowser.getAttribute("remote") == "true";
		log("_startGesture(" + event.target.localName + ") " + (this._isRemote ? "[e10s]" : ""));	// #debug
		this.sourceNode = event.target;
		this._lastX = event.screenX;
		this._lastY = event.screenY;
		this._directionChain = "";
		this._shouldFireContext = false;
		// trail drawing
		if (!this._swipeTimer && this._trailEnabled)
			this._createTrail();
		// [e10s] tell remote browser that mouse gesture has started
		if (this._isRemote) {
			var zoom = this._drawArea.mCurrentBrowser.fullZoom;
			this._gestureObserver.sendAsyncMessage("FireGestures:GestureStart", {
				type: event.type, 
				button: event.button, 
				x: (event.screenX - this._drawArea.mCurrentBrowser.boxObject.screenX) / zoom, 
				y: (event.screenY - this._drawArea.mCurrentBrowser.boxObject.screenY) / zoom, 
			});
		}
	},

	// called from handleEvent (type is "mousemove")
	_progressGesture: function FGH__progressGesture(event) {
		var x = event.screenX;
		var y = event.screenY;
		
		// Swap the dy measurement to get conventional angles later
		var dx = x - this._lastX;
		var dy = this._lastY - y;
		
		// ignore minimal mouse movement
		if (Math.abs(dx) < this._deadzone && Math.abs(dy) < this._deadzone)
			return;
		
		var direction;
		if (this._useDiagonals) {
			// Angle determination in degrees
			var angle = Math.atan2(dy, dx) * (180/Math.PI);

			// Correction for 180-360 degrees
			if (angle < 0)
				angle = 360 - Math.abs(angle);

			// current direction
			// var direction;
			if (angle >= 22.5 && angle < 67.5) {
				direction = "9";
			} else if (angle >= 67.5 && angle < 112.5) {
				direction = "U";
			} else if (angle >= 112.5 && angle < 157.5) {
				direction = "7";
			} else if (angle >= 157.5 && angle < 202.5) {
				direction = "L";
			} else if (angle >= 202.5 && angle < 247.5) {
				direction = "1";
			} else if (angle >= 247.5 && angle < 292.5) {
				direction = "D";
			} else if (angle >= 292.5 && angle < 337.5) {
				direction = "3";
			} else {
				direction = "R";
			}
		} else {
			if (Math.abs(dx) > Math.abs(dy))
				direction = x < this._lastX ? "L" : "R";
			else
				direction = y < this._lastY ? "U" : "D";
		}
		
		
		// trail drawing
		if (this._trailEnabled)
			this._drawTrail(this._lastX, this._lastY, x, y);
		// remember the current position
		this._lastX = x;
		this._lastY = y;
		// don't fire onDirectionChange while performing keypress gesture
		if (this._state == STATE_KEYPRESS)
			return;
		// compare to the last direction
		// compare to the last direction
		this._processDirection(event, direction);
		
		if (this._gestureTimeout > 0)
			this._setTimeout(this._gestureTimeout);
	},
	
	_processDirection: function FGH_processDirection(event, direction) {
		// check direction against last element of _directionChain
		var lastDirection = this._directionChain.charAt(this._directionChain.length - 1);
		if (direction != lastDirection) {
			var chainDir = this._nodesChain.charAt(0);
			var chainRE = new RegExp('^[' + chainDir + ']*$');

			// check if the temporary chain is consistent with the direction
			if (chainRE.test(this._nodesChain) && chainDir == direction) {
				// add the current direction to the directionChain
				this._directionChain += direction;
				this._gestureObserver.onDirectionChanged(event, this._directionChain);
			} else {
				// add the current direction to the temporary chain
				if (this._nodesChain.length == this._minNodes) {
					this._nodesChain = this._nodesChain.substr(1, this._nodesChain.length - 1) + direction;
				} else {
					this._nodesChain = this._nodesChain + direction;
				}
			}
		}
	},

	// called from handleEvent (type is "mousedown", "mousemove", "DOMMouseScroll", "click")
	_invokeExtraGesture: function FGH__invokeExtraGesture(event, aGestureType) {
		log("_invokeExtraGesture(" + aGestureType + ", _state = " + this._state + ")");	// #debug
		// @see EscapeFromWheelGestureFx3.diff
		if (this._state == STATE_WHEEL || this._state == STATE_ROCKER) {
			this._lastExtraX = event.screenX;
			this._lastExtraY = event.screenY;
		}
		// clear trail drawing when invoking extra gesture except keypress gesture
		if (this._state != STATE_KEYPRESS && this._trailEnabled)
			this._eraseTrail();
		// Fixed bug: FireGestures.sourceNode is null when doing rocker-right
		if (!this.sourceNode)
			this.sourceNode = event.target;
		this._gestureObserver.onExtraGesture(event, aGestureType);
		this._suppressContext = true;
		this._shouldFireContext = false;
		this._directionChain = "";
		// set timer for invalid wheel gesture / rocker gesture
		if (this._state == STATE_WHEEL || this._state == STATE_ROCKER) {
			if (this._gestureTimeout > 0)
				this._setTimeout(this._gestureTimeout);
		}
	},

	// called from handleEvent (type is "mousemove" or "mouseup"), notify, openPopupAtPointer
	_stopGesture: function FGH__stopGesture(event) {
		log("_stopGesture(" + this._directionChain + ")");	// #debug
		this._state = STATE_READY;
		this._isMouseDownL = false;
		this._isMouseDownM = false;
		this._isMouseDownR = false;
		this._clearTimeout();
		// clear trail drawing
		if (!this._swipeTimer && this._trailEnabled)
			this._eraseTrail();
		// don't call onMouseGesture after events sequence: mousedown > minimal mousemove > mouseup
		if (this._directionChain) {
			// reset direction chain before calling onMouseGesture to fix issue#125
			var directionChain = this._directionChain;
			this._directionChain = "";
			this._gestureObserver.onMouseGesture(event, directionChain);
			// suppress immediate context menu after finishing mouse gesture with right-button
			// don't suppress mouse gesture with left or middle button
			this._suppressContext = true;
			this._shouldFireContext = false;
		}
		this.sourceNode = null;
	},


	/* ::::: nsIObserver ::::: */

	observe: function FGH_observe(aSubject, aTopic, aData) {
		// log("observe(" + aSubject + ", " + aTopic + ", " + aData + ")");	// #debug
		if (aTopic == "nsPref:changed")
			this._reloadPrefs();
	},


	/* ::::: nsITimerCallback ::::: */

	// start timer for gesture timeout
	_setTimeout: function FGH__setTimeout(aMsec) {
		this._clearTimeout();
		this._gestureTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
		this._gestureTimer.initWithCallback(this, aMsec, Ci.nsITimer.TYPE_ONE_SHOT);
	},

	// stop timer for gesture timeout
	_clearTimeout: function FGH__clearTimeout() {
		if (this._gestureTimer) {
			this._gestureTimer.cancel();
			this._gestureTimer = null;
		}
	},

	notify: function(aTimer) {
		switch (aTimer) {
			case this._gestureTimer: 
				log("gesture-timeout");	// #debug
				this._suppressContext = true;
				this._shouldFireContext = false;
				this._directionChain = "";
				this._stopGesture();
				this._gestureObserver.onExtraGesture(null, "gesture-timeout");
				break;
			case this._swipeTimer: 
				this._stopGesture();
				this._swipeTimer = null;
				break;
		}
	},

	openPopupAtPointer: function FGH_openPopupAtPointer(aPopup) {
		var ratio = 1;
		var os = Cc["@mozilla.org/system-info;1"].getService(Ci.nsIPropertyBag2).getProperty("name");
		if (os == "Darwin") {
			// [Mac] multiply openPopupAtScreen args by layout.css.devPixelsPerPx
			ratio = aPopup.ownerDocument.defaultView.QueryInterface(Ci.nsIInterfaceRequestor).
		            getInterface(Ci.nsIDOMWindowUtils).screenPixelsPerCSSPixel;
		}
		aPopup.openPopupAtScreen(this._lastX * ratio, this._lastY * ratio, false);
		// stop gesture
		this._directionChain = "";
		// _stopGesture is called twice when popup is open from wheel gesture,
		// but this is required to initialize flags and free memory
		this._stopGesture();
	},

	cancelMouseGesture: function FGH_cancelMouseGesture() {
		this._directionChain = "";
		this._stopGesture();
	},


	/* ::::: MOUSE TRAIL ::::: */

	_trailArea: null,
	_trailContext: null,
	_trailOffsetX: 0,
	_trailOffsetY: 0,

	// called from _startGesture
	_createTrail: function FGH__createTrail() {
		var doc = this._drawArea.ownerDocument;
		var box = doc.documentElement.boxObject;
		if (this._trailArea) {
			this._trailArea.style.display = "-moz-box";
			this._trailOffsetX = box.screenX;
			this._trailOffsetY = box.screenY;
			var canvas = this._trailArea.firstChild;
			canvas.setAttribute("width",  box.width);
			canvas.setAttribute("height", box.height);
			return;
		}
		var css = "-moz-user-focus: none !important;"
		        + "-moz-user-select: none !important;"
		        + "display: -moz-box !important;"
		        + "box-sizing: border-box !important;"
		        + "pointer-events: none !important;"
		        + "margin: 0 !important;"
		        + "padding: 0 !important;"
		        + "width: 100% !important;"
		        + "height: 100% !important;"
		        + "border: none !important;"
		        + "box-shadow: none !important;"
		        + "overflow: hidden !important;"
		        + "background: none !important;"
		        + "opacity: 0.6 !important;"
		        + "position: fixed !important;"
		        + "top:  " + box.y + "px !important;"
		        + "left: " + box.x + "px !important;"
		        + "z-index: 2147483647 !important;";
		this._trailArea = doc.createElement("hbox");
		this._trailArea.id = "FireGesturesTrail";
		this._trailArea.style.cssText = css;
		this._trailOffsetX = box.screenX;
		this._trailOffsetY = box.screenY;
		var canvas = doc.createElementNS(HTML_NS, "canvas");
		canvas.setAttribute("width",  box.width);
		canvas.setAttribute("height", box.height);
		this._trailArea.appendChild(canvas);
		doc.documentElement.appendChild(this._trailArea);
		this._trailContext = canvas.getContext("2d");
	},

	// called from _progressGesture
	_drawTrail: function FGH__drawTrail(x1, y1, x2, y2) {
		if (!this._trailArea)
			return;
		var context = this._trailContext;
		context.strokeStyle = this._trailColor;
		context.lineJoin = "round";
		context.lineWidth = this._trailSize;
		context.beginPath();
		context.moveTo(x1 - this._trailOffsetX, y1 - this._trailOffsetY);
		context.lineTo(x2 - this._trailOffsetX, y2 - this._trailOffsetY);
		context.closePath();
		context.stroke();
	},

	// called from _stopGesture, _invokeExtraGesture
	_eraseTrail: function FGH__eraseTrail() {
		if (!this._trailArea)
			return;
		var canvas = this._trailArea.firstChild;
		this._trailContext.clearRect(0, 0, canvas.getAttribute("width"), canvas.getAttribute("height"));
		this._trailArea.style.display = "none";
	},

};


////////////////////////////////////////////////////////////////////////////////
// XPCOM registration

var NSGetFactory = XPCOMUtils.generateNSGetFactory([xdGestureHandler]);


