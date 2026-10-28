// This file is part of Moodle - http://moodle.org/
//
// Moodle is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Moodle is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with Moodle.  If not, see <http://www.gnu.org/licenses/>.

/**
 * player.js
 *
 * @package   mod_supervideo
 * @copyright 2026 Eduardo Kraus {@link https://eduardokraus.com}
 * @license   http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

var that = this;
var supervideoCleanup = [];
var supervideoSaveTimer = null;
var supervideoMap = [];
var supervideoLastBucket = -1;
var supervideoLastPercent = -1;
var supervideoDuration = 0;

this.supervideoLoading = true;
this.supervideoError = '';
this.supervideoData = null;
this.supervideoPercent = null;

function cleanup() {
    supervideoCleanup.forEach(function(fn) {
        try { fn(); } catch (e) { /* Ignore stale player cleanup. */ }
    });
    supervideoCleanup = [];
    if (supervideoSaveTimer) {
        clearTimeout(supervideoSaveTimer);
        supervideoSaveTimer = null;
    }
}

function currentSite() {
    var siteId = that.CoreSitesProvider.getCurrentSiteId();
    return that.CoreSitesProvider.getSite(siteId);
}

function decodeMap(encoded) {
    try {
        var parsed = JSON.parse(atob(encoded || ''));
        return Array.isArray(parsed) ? parsed : Object.assign([], parsed || {});
    } catch (e) {
        return [];
    }
}

function progressLength(duration) {
    return Math.max(1, Math.min(100, Math.floor(duration || 100)));
}

function saveProgress(currentTime, duration, force) {
    currentTime = Math.max(0, Math.floor(Number(currentTime) || 0));
    duration = Math.max(0, Math.floor(Number(duration) || 0));
    if (!duration || !that.supervideoData) {
        return;
    }
    if (duration - currentTime <= 1 && currentTime > 0) {
        currentTime = duration;
    }
    supervideoDuration = duration;
    var length = progressLength(duration);
    var bucket = length < 100 ? currentTime : Math.floor(currentTime / duration * length);
    bucket = Math.max(0, Math.min(length, bucket));
    if (bucket > 0) {
        supervideoMap[bucket] = 1;
    }

    var watched = 0;
    for (var i = 1; i <= length; i++) {
        watched += supervideoMap[i] ? 1 : 0;
    }
    var percent = length < 100 ? Math.floor(watched / length * 100) : watched;
    that.supervideoPercent = percent;

    if (!force && bucket === supervideoLastBucket && percent === supervideoLastPercent) {
        return;
    }
    supervideoLastBucket = bucket;
    supervideoLastPercent = percent;

    var send = function() {
        supervideoSaveTimer = null;
        currentSite().then(function(site) {
            return site.write('mod_supervideo_progress_save_mobile', {
                view_id: that.supervideoData.config.viewid,
                currenttime: currentTime,
                duration: duration,
                percent: percent,
                map: JSON.stringify(supervideoMap)
            });
        }).catch(function(error) {
            console.warn('mod_supervideo progress could not be saved', error);
        });
    };

    if (force) {
        if (supervideoSaveTimer) {
            clearTimeout(supervideoSaveTimer);
            supervideoSaveTimer = null;
        }
        send();
    } else if (!supervideoSaveTimer) {
        supervideoSaveTimer = setTimeout(send, 1200);
    }
}

function waitFor(selector, callback, attempts) {
    var element = document.querySelector(selector);
    if (element) {
        callback(element);
        return;
    }
    if ((attempts || 0) >= 30) {
        return;
    }
    setTimeout(function() { waitFor(selector, callback, (attempts || 0) + 1); }, 100);
}

function loadScript(src, test, callback, integrity) {
    if (test()) {
        callback();
        return;
    }
    var existing = document.querySelector('script[src="' + src + '"]');
    if (existing) {
        existing.addEventListener('load', callback, {once: true});
        return;
    }
    var script = document.createElement('script');
    script.src = src;
    if (integrity) {
        script.integrity = integrity;
        script.crossOrigin = 'anonymous';
    }
    script.onload = callback;
    document.head.appendChild(script);
}

function bindHtml5() {
    waitFor('#mod-supervideo-media-' + that.supervideoCmid, function(media) {
        if (that.supervideoData.config.currenttime > 0) {
            media.currentTime = that.supervideoData.config.currenttime;
        }
        var onTime = function() { saveProgress(media.currentTime, media.duration, false); };
        var onPause = function() { saveProgress(media.currentTime, media.duration, true); };
        var onEnded = function() { saveProgress(media.duration, media.duration, true); };
        media.addEventListener('timeupdate', onTime);
        media.addEventListener('pause', onPause);
        media.addEventListener('ended', onEnded);
        supervideoCleanup.push(function() {
            media.removeEventListener('timeupdate', onTime);
            media.removeEventListener('pause', onPause);
            media.removeEventListener('ended', onEnded);
        });

        if (that.supervideoData.content.ishls && media.tagName === 'VIDEO' &&
                !media.canPlayType('application/vnd.apple.mpegurl')) {
            loadScript('https://cdn.jsdelivr.net/npm/hls.js@1.7.3/dist/hls.min.js', function() { return !!window.Hls; }, function() {
                if (window.Hls && window.Hls.isSupported()) {
                    var hls = new window.Hls();
                    hls.loadSource(that.supervideoData.content.fileurl);
                    hls.attachMedia(media);
                    supervideoCleanup.push(function() { hls.destroy(); });
                }
            }, 'sha256-oS5+4c1kpp3NsxQVfkXa/LpwW/sLFEC3k1yyZdN0Qj4=');
        }
    });
}

function bindYoutube() {
    var previous = window.onYouTubeIframeAPIReady;
    var initialise = function() {
        if (!window.YT || !window.YT.Player) { return; }
        waitFor('#mod-supervideo-api-player-' + that.supervideoCmid, function(target) {
            var player = null;
            var interval = null;
            var videoid = that.supervideoData.content.providerid;

            target.innerHTML = '';
            var wrapper = document.createElement('div');
            wrapper.className = 'supervideo-player-wrapper paused';
            wrapper.style.cssText = 'position:relative;width:100%;height:0;padding-bottom:56.25%;background:#000;overflow:hidden;direction:ltr!important;';

            var iframeHost = document.createElement('div');
            iframeHost.id = 'yt-host-' + that.supervideoCmid;
            wrapper.appendChild(iframeHost);

            var poster = document.createElement('div');
            poster.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:50;background:#000 url(https://img.youtube.com/vi/' + videoid + '/maxresdefault.jpg) center/cover no-repeat;cursor:pointer;';
            wrapper.appendChild(poster);

            var protection = document.createElement('div');
            protection.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:40;background:transparent;cursor:pointer;';
            wrapper.appendChild(protection);

            var controls = document.createElement('div');
            controls.style.cssText = 'position:absolute;bottom:0;left:0;right:0;height:44px;background:linear-gradient(transparent,rgba(0,0,0,0.8));display:flex;align-items:center;padding:0 8px;gap:6px;z-index:100;direction:ltr!important;';
            controls.innerHTML = '<button type="button" style="background:none;border:none;color:#fff;font-size:20px;padding:4px 8px;cursor:pointer;" class="sv-m-play">▶</button>' +
                '<div style="flex:1;height:6px;background:rgba(255,255,255,0.3);border-radius:3px;position:relative;cursor:pointer;touch-action:none;" class="sv-m-prog">' +
                '<div style="height:100%;background:#ff0000;border-radius:3px;width:0%;" class="sv-m-bar"></div></div>' +
                '<span style="color:#fff;font-size:11px;font-family:sans-serif;white-space:nowrap;" class="sv-m-time">0:00 / 0:00</span>';
            wrapper.appendChild(controls);

            target.appendChild(wrapper);

            var playBtn = controls.querySelector('.sv-m-play');
            var progCont = controls.querySelector('.sv-m-prog');
            var progBar = controls.querySelector('.sv-m-bar');
            var timeDisp = controls.querySelector('.sv-m-time');

            function fmt(s) {
                s = Math.floor(s || 0);
                var m = Math.floor(s / 60);
                var sec = s % 60;
                return m + ':' + (sec < 10 ? '0' : '') + sec;
            }

            function toggle() {
                if (player && player.getPlayerState) {
                    var st = player.getPlayerState();
                    if (window.YT && st === window.YT.PlayerState.PLAYING) {
                        player.pauseVideo();
                    } else {
                        player.playVideo();
                    }
                }
            }
            playBtn.addEventListener('click', toggle);
            poster.addEventListener('click', toggle);
            protection.addEventListener('click', toggle);

            function seek(e) {
                if (player && player.getDuration) {
                    var r = progCont.getBoundingClientRect();
                    var cx = (e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX);
                    var p = Math.max(0, Math.min(1, (cx - r.left) / r.width));
                    var d = player.getDuration();
                    player.seekTo(p * d, true);
                    progBar.style.width = (p * 100) + '%';
                    timeDisp.textContent = fmt(p * d) + ' / ' + fmt(d);
                }
            }
            progCont.addEventListener('click', seek);
            progCont.addEventListener('touchstart', seek, {passive: true});
            progCont.addEventListener('touchmove', seek, {passive: true});

            player = new window.YT.Player(iframeHost.id, {
                videoId: videoid,
                width: '100%',
                height: '100%',
                playerVars: {
                    rel: 0,
                    playsinline: 1,
                    controls: 0,
                    modestbranding: 1,
                    iv_load_policy: 3,
                    disablekb: 1,
                    fs: 0,
                    autoplay: that.supervideoData.config.autoplay ? 1 : 0,
                    start: that.supervideoData.config.currenttime || 0
                },
                events: {
                    onReady: function() {
                        var iframe = wrapper.querySelector('iframe');
                        if (iframe) {
                            iframe.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none!important;border:0;';
                        }
                    },
                    onStateChange: function(event) {
                        if (event.data === window.YT.PlayerState.PLAYING) {
                            poster.style.display = 'none';
                            playBtn.textContent = '❚❚';
                            if (!interval) {
                                interval = setInterval(function() {
                                    var ct = player.getCurrentTime();
                                    var dur = player.getDuration();
                                    if (dur > 0) {
                                        progBar.style.width = ((ct / dur) * 100) + '%';
                                        timeDisp.textContent = fmt(ct) + ' / ' + fmt(dur);
                                    }
                                    saveProgress(ct, dur, false);
                                }, 1000);
                            }
                        } else {
                            playBtn.textContent = '▶';
                            if (interval) {
                                clearInterval(interval);
                                interval = null;
                            }
                            if (player.getCurrentTime && player.getDuration) {
                                saveProgress(player.getCurrentTime(), player.getDuration(), true);
                            }
                        }
                        if (event.data === window.YT.PlayerState.ENDED) {
                            saveProgress(player.getDuration(), player.getDuration(), true);
                        }
                    }
                }
            });

            supervideoCleanup.push(function() {
                if (interval) { clearInterval(interval); }
                if (player && player.destroy) { player.destroy(); }
            });
        });
    };
    window.onYouTubeIframeAPIReady = function() {
        if (typeof previous === 'function') { previous(); }
        initialise();
    };
    loadScript('https://www.youtube.com/iframe_api', function() { return !!(window.YT && window.YT.Player); }, initialise);
}

function getCoreIframe(callback) {
    waitFor('#mod-supervideo-frame-' + that.supervideoCmid, function(component) {
        var find = function(count) {
            var iframe = component.querySelector ? component.querySelector('iframe') : null;
            if (iframe) { callback(iframe); return; }
            if (count < 30) { setTimeout(function() { find(count + 1); }, 100); }
        };
        find(0);
    });
}

function bindVimeo() {
    getCoreIframe(function(iframe) {
        loadScript('https://player.vimeo.com/api/player.js', function() { return !!(window.Vimeo && window.Vimeo.Player); }, function() {
            var player = new window.Vimeo.Player(iframe);
            if (that.supervideoData.config.currenttime > 0) {
                player.setCurrentTime(that.supervideoData.config.currenttime).catch(function() {});
            }
            var onTime = function(data) { saveProgress(data.seconds, data.duration, false); };
            var onEnded = function(data) { saveProgress(data.duration, data.duration, true); };
            player.on('timeupdate', onTime);
            player.on('ended', onEnded);
            supervideoCleanup.push(function() {
                player.off('timeupdate', onTime);
                player.off('ended', onEnded);
            });
        });
    });
}

function bindMessages(type) {
    getCoreIframe(function(iframe) {
        var trustedOrigin = that.supervideoData.content.trustedorigin;
        var providerData = {};
        try { providerData = JSON.parse(that.supervideoData.content.providerdata || '{}'); } catch (e) {}
        var identifiers = new Set((providerData.identifiers || []).map(function(item) {
            return typeof item === 'string' ? item : item.identifier;
        }).filter(Boolean));
        var duration = 0;

        var receive = function(event) {
            if (!event || !event.data || event.source !== iframe.contentWindow ||
                    !trustedOrigin || event.origin !== trustedOrigin) {
                return;
            }
            var data = event.data;
            if (type === 'pandavideo') {
                if (data.message === 'panda_allData' && data.playerData) {
                    duration = Number(data.playerData.duration) || 0;
                } else if (data.message === 'panda_timeupdate' && duration) {
                    saveProgress(data.currentTime, duration, false);
                }
            } else if (type === 'ottflix') {
                if (data.origem === 'OTTFLIX-player' && identifiers.has(data.identifier) && data.name === 'progress') {
                    saveProgress(data.currentTime, data.duration, false);
                }
            } else if (type === 'embed' && data.origem === 'supervideo-embed' && data.name === 'progress') {
                saveProgress(data.currentTime, data.duration, false);
            }
        };
        window.addEventListener('message', receive);
        supervideoCleanup.push(function() { window.removeEventListener('message', receive); });

        if (type === 'pandavideo' && trustedOrigin) {
            iframe.contentWindow.postMessage({type: 'currentTime', parameter: that.supervideoData.config.currenttime || 0}, trustedOrigin);
        }
    });
}

this.supervideoPlaybackLoaded = function(result) {
    cleanup();
    this.supervideoLoading = false;
    this.supervideoError = '';
    this.supervideoData = result;
    this.supervideoCmid = Number((this.CONTENT_OTHERDATA && this.CONTENT_OTHERDATA.cmid) || this.supervideoCmid || 0);
    supervideoMap = decodeMap(result.config.datamap);
    this.supervideoPercent = null;

    // cmid is injected below by the PHP template before this code is evaluated.
    var type = result.content.type;
    setTimeout(function() {
        if (type === 'file' || type === 'link') {
            bindHtml5();
        } else if (type === 'youtube') {
            bindYoutube();
        } else if (type === 'vimeo') {
            bindVimeo();
        } else if (type === 'drive') {
            saveProgress(1, 1, true);
        } else if (type === 'pandavideo' || type === 'ottflix' || type === 'embed') {
            bindMessages(type);
        }
    }, 0);
};

this.supervideoPlaybackError = function(error) {
    cleanup();
    this.supervideoLoading = false;
    this.supervideoData = null;
    this.supervideoError = error && error.message ? error.message : 'Unable to load Super Video.';
};

// The handler PHP sets this value in otherdata/template context via literal replacement.
this.supervideoCmid = Number((this.CONTENT_OTHERDATA && this.CONTENT_OTHERDATA.cmid) || 0);

this.ionViewWillLeave = function() {
    cleanup();
};
