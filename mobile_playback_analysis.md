# Mobile Video Playback & Progress Bar Touch-Seeking Analysis

This document provides a comprehensive analysis of the video playback and progress bar interaction failures on mobile browsers (such as iOS Safari and Android Chrome) and the Moodle Mobile App for the `mod_supervideo` plugin.

---

## 1. Root Cause Analysis

### A. Strict Mobile Browser Autoplay/Gesture Policies
To save battery and data, mobile operating systems restrict media playback. A video with audio **cannot** be played programmatically via JavaScript (e.g., calling YouTube's `player.playVideo()`) unless it is initiated by a **direct user gesture** on the media element or its embedding iframe.

### B. The Pointer Events Blockade (Blocks Video Loading)
In the plugin's CSS (`styles.css`), the iframe wrapping YouTube, Vimeo, and other players is styled as follows:
```css
.supervideo-player-wrapper iframe {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none !important;
  border: 0;
}
```
* **The Mobile Side Effect:** Setting `pointer-events: none !important` makes the iframe completely "invisible" to touch events. The user's touch is instead captured by the overlays above it (`.supervideo-poster-overlay` or `.supervideo-protection-overlay`). When the JavaScript event handler on the overlay tries to call `player.playVideo()`, the mobile browser blocks it because **the iframe itself never registered a direct user interaction**.

### C. Touch-Seeking Limitations on the Progress Bar
Currently, the custom YouTube player in `player_create.js` uses a custom progress bar (`.supervideo-progress-container`) and progress map segments (`#mapa-visualizacao .clique div`).
These elements only listen to the `click` event:
```javascript
progressContainer.addEventListener('click', function (e) { ... });
```
* **The Mobile Side Effect:** 
  1. On mobile devices, when a user tries to drag or slide their finger along the progress bar to go forward, a `touchmove` event is triggered, but since there is no touch listener, **the slide action is completely ignored**.
  2. If they attempt to tap the bar to seek, the simulated `click` event's `e.clientX` property can sometimes be undefined or inaccurate, failing to register the correct seek time.

---

## 2. The Solution Plan

To resolve both the **video playback block** and the **progress bar touch-seeking issues**, we need to implement a combined CSS + JS fix.

### Phase 1: CSS Fix (Restores Playback and Vimeo seeking)
We use a media query targeting touch pointer devices (`@media (pointer: coarse)`) to make the iframe clickable and make the overlays transparent to touch events so they pass through directly to the player:

```css
@media (pointer: coarse) {
  /* Allow touch events to reach the video iframe so mobile browsers register user gesture */
  .supervideo-player-wrapper iframe {
    pointer-events: auto !important;
  }

  /* Make overlays transparent to touches so they pass through to the iframe */
  .supervideo-poster-overlay,
  .supervideo-protection-overlay,
  .supervideo-big-play {
    pointer-events: none !important;
  }
}
```

### Phase 2: JavaScript Fix (Enables Touch Tapping & Drag-Seeking)
We will update `amd/src/player_create.js` to add touch event handlers (`touchstart` and `touchmove`) to the progress bar and map segments to capture touch coordinates (`e.touches[0].clientX`) correctly.

#### A. YouTube Custom Progress Bar Fix
Update the event listeners for `progressContainer` in `player_create.js` to support touch events:
```javascript
function handleProgressSeek(e) {
    if (player && player.getDuration) {
        var rect = progressContainer.getBoundingClientRect();
        var clientX;
        if (e.touches && e.touches.length > 0) {
            clientX = e.touches[0].clientX;
        } else if (e.changedTouches && e.changedTouches.length > 0) {
            clientX = e.changedTouches[0].clientX;
        } else {
            clientX = e.clientX;
        }
        var percent = (clientX - rect.left) / rect.width;
        percent = Math.max(0, Math.min(1, percent));
        var time = percent * player.getDuration();
        player.seekTo(time, true);
    }
}
progressContainer.addEventListener('click', handleProgressSeek);
progressContainer.addEventListener('touchstart', handleProgressSeek, { passive: true });
progressContainer.addEventListener('touchmove', handleProgressSeek, { passive: true });
```

#### B. Progress Map Segment Fix
Update the map click binding to listen to both `click` and `touchstart`:
```javascript
var $mapa_clique =
    $("<div></div>")
        .attr("title", tempo)
        .attr("data-currenttime", mapaTitle)
        .on('click touchstart', function (e) {
            var _setCurrentTime = $(this).attr("data-currenttime");
            _setCurrentTime = parseInt(_setCurrentTime);

            var event = document.createEvent("CustomEvent");
            event.initCustomEvent("setCurrentTime", true, true, { goCurrentTime: _setCurrentTime });
            document.dispatchEvent(event);
        });
```
