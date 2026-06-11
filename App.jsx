import React, { useState, useEffect, useRef } from 'react';
import { 
  Map as MapIcon, Search, Navigation, Moon, Sun, 
  MapPin, Route, ChevronRight, X, AlertCircle, 
  Car, Footprints, Bike, ArrowRightLeft, 
  CheckCircle, Play, Compass, FastForward, Plus, 
  Trash2, History, Bookmark, Volume2, VolumeX, Share2, Download, 
  LocateFixed, Zap, WifiOff
} from 'lucide-react';

// --- CONFIGURATION & HELPERS ---
const TILE_URL = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';

const ROUTING_PROFILES = { driving: 'car', walking: 'foot', cycling: 'bike' };

const formatDistance = (meters, useMiles = true) => {
  if (!meters || isNaN(meters)) return '0 mi';
  if (useMiles) {
    const miles = meters * 0.000621371;
    if (miles < 0.1) return `${Math.round(meters * 3.28084)} ft`;
    return `${miles.toFixed(1)} mi`;
  }
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
};

const formatDuration = (seconds) => {
  if (!seconds || isNaN(seconds)) return '0 min';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h} hr ${m} min`;
  return `${m} min`;
};

const calculateETA = (seconds) => {
  if (!seconds || isNaN(seconds)) return '--:--';
  const date = new Date(Date.now() + seconds * 1000);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const getDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371e3; 
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * rad) * Math.cos(lat2 * rad) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c; 
};

// --- CUSTOM HOOKS ---
function useDebounce(value, delay) {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
}

function useLocalStorage(key, initialValue) {
  const [storedValue, setStoredValue] = useState(() => {
    try {
      const item = typeof window !== 'undefined' ? window.localStorage.getItem(key) : null;
      return item ? JSON.parse(item) : initialValue;
    } catch (error) { 
      return initialValue; 
    }
  });
  
  const setValue = (value) => {
    try {
      const valueToStore = value instanceof Function ? value(storedValue) : value;
      setStoredValue(valueToStore);
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(key, JSON.stringify(valueToStore));
      }
    } catch (error) { console.error(error); }
  };
  return [storedValue, setValue];
}

// --- MAIN APPLICATION COMPONENT ---
export default function GlobalRouteNavigator() {
  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const markersRef = useRef({ waypoints: [], user: null });
  const polylineRef = useRef(null);
  const decoratorRef = useRef(null);
  const LRef = useRef(null);

  // --- CORE STATE ---
  const [darkMode, setDarkMode] = useLocalStorage('theme_dark', false);
  const [activeTab, setActiveTab] = useState('plan');
  
  // Waypoints Array replacing start/end point (Multi-stop feature)
  const [waypoints, setWaypoints] = useState([
    { id: 'wp-start', lat: null, lng: null, label: '' },
    { id: 'wp-end', lat: null, lng: null, label: '' }
  ]);
  
  const [travelMode, setTravelMode] = useState('driving');
  const [routeData, setRouteData] = useState(null);
  const [routeError, setRouteError] = useState('');
  const [loadingRoute, setLoadingRoute] = useState(false);
  const [isOffline, setIsOffline] = useState(typeof navigator !== 'undefined' ? !navigator.onLine : false);

  // Search State
  const [activeInputIdx, setActiveInputIdx] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const debouncedSearch = useDebounce(searchQuery, 400);

  // Persistent Data Storage
  const [routeHistory, setRouteHistory] = useLocalStorage('route_history', []);
  const [savedRoutes, setSavedRoutes] = useLocalStorage('saved_routes', []);

  // Navigation State
  const [navState, setNavState] = useState({
    isActive: false,
    isSimulating: false,
    currentStepIndex: 0,
    remainingDistance: 0,
    remainingTime: 0,
    eta: '',
    currentInstruction: null,
    simSpeed: 10,
    currentSpeedMph: 0
  });
  
  const [voiceEnabled, setVoiceEnabled] = useLocalStorage('voice_enabled', true);
  const [autoCenter, setAutoCenter] = useState(true);
  const [pendingResume, setPendingResume] = useState(null);

  const simulationTimer = useRef(null);
  const watchIdRef = useRef(null);
  const simIndexRef = useRef(0);
  const lastSpokenInstruction = useRef('');

  // Map & Error Triggers
  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const [mapLoadError, setMapLoadError] = useState('');
  const [gpsWarning, setGpsWarning] = useState('');
  const [locationWarning, setLocationWarning] = useState('');
  
  // Synchronized Refs to cure stale closures
  const navStateRef = useRef(navState);
  const routeDataRef = useRef(routeData);
  const travelModeRef = useRef(travelMode);
  const autoCenterRef = useRef(autoCenter);
  const waypointsRef = useRef(waypoints);

  useEffect(() => { navStateRef.current = navState; }, [navState]);
  useEffect(() => { routeDataRef.current = routeData; }, [routeData]);
  useEffect(() => { travelModeRef.current = travelMode; }, [travelMode]);
  useEffect(() => { autoCenterRef.current = autoCenter; }, [autoCenter]);
  useEffect(() => { waypointsRef.current = waypoints; }, [waypoints]);

  // Network Offline Detector
  useEffect(() => {
    const handleOffline = () => setIsOffline(true);
    const handleOnline = () => setIsOffline(false);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, []);

  // Theme Initializer
  useEffect(() => {
    const root = document.documentElement;
    darkMode ? root.classList.add('dark') : root.classList.remove('dark');
  }, [darkMode]);

  // URL Deep Link Processing (Share Route)
  useEffect(() => {
    const hash = window.location.hash;
    if (hash && hash.startsWith('#route=')) {
      try {
        const decoded = JSON.parse(atob(hash.replace('#route=', '')));
        if (Array.isArray(decoded) && decoded.length >= 2) {
          setWaypoints(decoded);
          window.location.hash = '';
        }
      } catch (e) { console.error("Invalid shared route URL"); }
    }
  }, []);

  // Stage 1: Session Recovery (Mount)
  useEffect(() => {
    const activeSession = window.localStorage.getItem('activeRouteSession');
    if (activeSession) {
      try {
        const parsed = JSON.parse(activeSession);
        if (parsed && Array.isArray(parsed.waypoints)) {
          setWaypoints(parsed.waypoints);
          setTravelMode(parsed.travelMode || 'driving');
          setPendingResume(parsed.isSimulating || false);
        }
      } catch (e) { window.localStorage.removeItem('activeRouteSession'); }
    }
  }, []); 

  // Stage 2: Trigger recovered session once route calculates
  useEffect(() => {
    if (pendingResume !== null && routeData) {
      // Small buffer to allow map markers to draw
      setTimeout(() => {
        if (window.confirm("You have an active navigation session. Do you want to resume?")) {
          startNavigation(pendingResume);
        } else {
          window.localStorage.removeItem('activeRouteSession');
        }
        setPendingResume(null);
      }, 500);
    }
  }, [routeData, pendingResume]); // eslint-disable-line react-hooks/exhaustive-deps

  // Map Initialization
  useEffect(() => {
    let isMounted = true;
    
    // Hardened asset loader that polls for execution completion to prevent React double-mount crashes
    const loadAsset = (url, type, id) => new Promise((resolve, reject) => {
      if (document.getElementById(id)) {
        // If it's already in the DOM, wait until it's actually loaded in memory
        const check = setInterval(() => {
          if (type === 'css' || (type === 'script' && window.L)) {
            clearInterval(check);
            resolve();
          }
        }, 50);
        return;
      }

      let element = document.createElement(type === 'css' ? 'link' : 'script');
      element.id = id;
      if (type === 'css') { element.rel = 'stylesheet'; element.href = url; } 
      else { element.src = url; }
      element.onload = resolve;
      element.onerror = () => reject();
      document.head.appendChild(element);
    });

    const initMapDependencies = async () => {
      try {
        await Promise.all([
          loadAsset('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css', 'css', 'leaflet-css'),
          loadAsset('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js', 'script', 'leaflet-js')
        ]);
        if (isMounted) { 
          LRef.current = window.L; 
          initMap(); 
        }
        loadAsset('https://unpkg.com/leaflet-polylinedecorator@1.6.4/dist/leaflet.polylineDecorator.js', 'script', 'leaflet-decorator-js').catch(()=>{});
      } catch (err) { 
        if (isMounted) setMapLoadError("Failed to load map engine assets. Please check your connection."); 
      }
    };

    initMapDependencies();

    return () => { 
      isMounted = false; 
      if (mapInstance.current) { 
        mapInstance.current.remove(); 
        mapInstance.current = null; 
      }
      if (simulationTimer.current) clearInterval(simulationTimer.current);
      if (watchIdRef.current && navigator.geolocation) navigator.geolocation.clearWatch(watchIdRef.current);
    };
  }, []);

  const initMap = () => {
    if (!mapRef.current || !LRef.current) return;
    const L = LRef.current;

    if (mapInstance.current) { mapInstance.current.remove(); mapInstance.current = null; }
    if (mapRef.current._leaflet_id) mapRef.current._leaflet_id = null;

    mapInstance.current = L.map(mapRef.current, { zoomControl: false, tap: false }).setView([39.8283, -98.5795], 4); 
    L.control.zoom({ position: 'topright' }).addTo(mapInstance.current);

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
      className: 'map-tiles'
    }).addTo(mapInstance.current);

    mapInstance.current.on('click', (e) => {
       if (navStateRef.current.isActive) return;
       handleMapClick(e.latlng.lat, e.latlng.lng);
    });

    // Detect panning to turn off auto-center temporarily
    // FIX: Switched from dragstart to mousedown/touchstart to prevent programmatic pans from disabling auto-center
    mapInstance.current.on('mousedown touchstart', () => {
       if (navStateRef.current.isActive && autoCenterRef.current) setAutoCenter(false);
    });

    setIsMapLoaded(true);
    setTimeout(() => { if (mapInstance.current) mapInstance.current.invalidateSize(); }, 250);
  };

  // --- WAYPOINT & SEARCH LOGIC ---
  const handleMapClick = async (lat, lng) => {
    if (navStateRef.current.isActive) return; 

    let label = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`);
      const data = await res.json();
      if (data && data.display_name) label = data.display_name.split(',').slice(0, 3).join(',').trim();
    } catch (e) {}

    setWaypoints(prev => {
      const newWps = [...prev];
      const emptyIdx = newWps.findIndex(wp => !wp.lat);
      if (emptyIdx !== -1) {
        newWps[emptyIdx] = { ...newWps[emptyIdx], lat, lng, label };
      } else {
        newWps[newWps.length - 1] = { ...newWps[newWps.length - 1], lat, lng, label };
      }
      return newWps;
    });
  };

  useEffect(() => {
    let isActive = true;
    const controller = new AbortController();

    const fetchGeocode = async () => {
      if (!debouncedSearch || debouncedSearch.length < 3) {
        setSearchResults([]); setIsSearching(false); return;
      }
      setIsSearching(true);
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(debouncedSearch)}&limit=5`, { signal: controller.signal });
        const data = await res.json();
        if (isActive && Array.isArray(data)) setSearchResults(data);
      } catch (err) { } 
      finally { if (isActive) setIsSearching(false); }
    };

    fetchGeocode();
    return () => { isActive = false; controller.abort(); };
  }, [debouncedSearch]);

  const handleSelectSearchResult = (result) => {
    if (activeInputIdx === null) return;
    const newWp = {
      ...waypoints[activeInputIdx],
      lat: parseFloat(result.lat),
      lng: parseFloat(result.lon),
      label: result.display_name.split(',').slice(0, 3).join(',').trim()
    };
    
    setWaypoints(prev => prev.map((wp, i) => i === activeInputIdx ? newWp : wp));
    setSearchQuery(''); setSearchResults([]); setActiveInputIdx(null);
  };

  const addWaypoint = () => {
    setWaypoints(prev => {
      const newWp = { id: `wp-${Date.now()}`, lat: null, lng: null, label: '' };
      return [...prev.slice(0, -1), newWp, prev[prev.length - 1]];
    });
  };

  const removeWaypoint = (index) => {
    if (waypoints.length <= 2) {
      setWaypoints(prev => prev.map((wp, i) => i === index ? { ...wp, lat: null, lng: null, label: '' } : wp));
    } else {
      setWaypoints(prev => prev.filter((_, i) => i !== index));
    }
  };

  const moveWaypoint = (index, direction) => {
    if ((direction === -1 && index === 0) || (direction === 1 && index === waypoints.length - 1)) return;
    setWaypoints(prev => {
      const copy = [...prev];
      const temp = copy[index];
      copy[index] = copy[index + direction];
      copy[index + direction] = temp;
      return copy;
    });
  };

  // --- ROUTING ENGINE ---
  useEffect(() => {
    let isActive = true;
    const controller = new AbortController();

    const validWaypoints = waypoints.filter(wp => wp.lat !== null && wp.lng !== null);
    
    if (validWaypoints.length < 2) {
      setRouteData(null); clearMapDrawings(); return;
    }
    
    if (navStateRef.current.isActive) return; 

    const fetchRoute = async () => {
      setLoadingRoute(true); setRouteError('');
      try {
        const profile = ROUTING_PROFILES[travelMode] || 'car';
        const coordinates = validWaypoints.map(wp => `${wp.lng},${wp.lat}`).join(';');
        const url = `https://router.project-osrm.org/route/v1/${profile}/${coordinates}?overview=full&geometries=geojson&steps=true`;
        
        const res = await fetch(url, { signal: controller.signal });
        const data = await res.json();

        if (!isActive) return;
        if (data.code !== 'Ok') throw new Error(data.message || 'Could not map route.');
        if (!data.routes || data.routes.length === 0) throw new Error("No route paths found between these locations.");

        const route = data.routes[0];
        
        // Aggregate steps safely
        let allSteps = [];
        if (route.legs) {
          route.legs.forEach(leg => {
             const validSteps = leg.steps?.filter(s => s.maneuver?.instruction || s.name) || [];
             allSteps = [...allSteps, ...validSteps];
          });
        }

        const startName = validWaypoints[0].label.split(',')[0] || 'Start';
        const endName = validWaypoints[validWaypoints.length-1].label.split(',')[0] || 'Destination';

        setRouteData({
          distance: route.distance,
          duration: route.duration,
          steps: allSteps,
          geometry: route.geometry,
          name: `${startName} to ${endName}`
        });

        drawRoute(route.geometry);
      } catch (err) {
        if (!isActive || err.name === 'AbortError') return;
        setRouteError(err.message || 'Route planning failed.');
        setRouteData(null); clearMapDrawings();
      } finally {
        if (isActive) setLoadingRoute(false);
      }
    };

    fetchRoute();
    return () => { isActive = false; controller.abort(); };
  }, [waypoints, travelMode]); 

  // --- DRAWING & MARKERS ---
  const clearMapDrawings = () => {
    if (polylineRef.current) polylineRef.current.remove?.();
    if (decoratorRef.current) decoratorRef.current.remove?.();
  };

  const drawRoute = (geoJsonGeometry) => {
    if (!LRef.current || !mapInstance.current) return;
    const L = LRef.current;
    clearMapDrawings();

    const latLngs = geoJsonGeometry.coordinates.map(coord => [coord[1], coord[0]]);

    polylineRef.current = L.polyline(latLngs, {
      color: '#3b82f6', weight: 8, opacity: 0.9, lineCap: 'round', lineJoin: 'round'
    }).addTo(mapInstance.current);

    if (L.polylineDecorator) {
       decoratorRef.current = L.polylineDecorator(polylineRef.current, {
        patterns: [{ offset: '5%', repeat: '100px', symbol: L.Symbol.arrowHead({ pixelSize: 12, polygon: true, pathOptions: { fillOpacity: 1, weight: 0, color: '#ffffff' } }) }]
      }).addTo(mapInstance.current);
    }

    if (!navStateRef.current.isActive) {
      try { mapInstance.current.fitBounds(polylineRef.current.getBounds(), { padding: [50, 50], animate: true }); } 
      catch (e) { }
    }
  };

  // Sync Waypoint Markers
  useEffect(() => {
    if (!LRef.current || !mapInstance.current) return;
    const L = LRef.current;

    const createIcon = (color, text) => L.divIcon({
      className: 'custom-map-marker',
      html: `<div style="background-color: ${color}; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.3); border: 2px solid white; transform: translate(-50%, -100%); color: white; font-weight: bold; font-size: 14px;">
              ${text}
             </div>`,
      iconSize: [0, 0], iconAnchor: [0, 0]
    });

    markersRef.current.waypoints.forEach(m => m?.remove?.());
    markersRef.current.waypoints = [];

    if (navState.isActive) return; 

    waypoints.forEach((wp, idx) => {
      if (!wp.lat) return;
      const isStart = idx === 0;
      const isEnd = idx === waypoints.length - 1;
      const color = isStart ? '#3b82f6' : isEnd ? '#ef4444' : '#f59e0b';
      const text = isStart ? 'A' : isEnd ? 'B' : `${idx}`;
      
      const marker = L.marker([wp.lat, wp.lng], { icon: createIcon(color, text) }).addTo(mapInstance.current);
      markersRef.current.waypoints.push(marker);
    });
  }, [waypoints, navState.isActive, routeData]);

  // --- TTS VOICE ---
  const speakInstruction = (text) => {
    if (!voiceEnabled || !('speechSynthesis' in window)) return;
    if (text === lastSpokenInstruction.current) return; 
    
    try {
      window.speechSynthesis.cancel();
      const msg = new SpeechSynthesisUtterance(text);
      msg.rate = 1.0;
      msg.pitch = 1.0;
      window.speechSynthesis.speak(msg);
      lastSpokenInstruction.current = text;
    } catch (e) {
      console.warn("Speech Synthesis blocked by browser.");
    }
  };

  // --- NAVIGATION SYSTEM ---
  const updateUserLocationMarker = (lat, lng) => {
    if (!LRef.current || !mapInstance.current) return;
    const L = LRef.current;

    if (!markersRef.current.user) {
      markersRef.current.user = L.marker([lat, lng], {
        icon: L.divIcon({
          className: 'navigation-user-marker',
          html: `<div class="relative flex items-center justify-center w-10 h-10">
                   <div class="absolute w-full h-full bg-blue-500 rounded-full animate-ping opacity-40"></div>
                   <div class="relative w-6 h-6 bg-blue-600 border-2 border-white rounded-full shadow-lg flex items-center justify-center">
                     <div class="w-1.5 h-1.5 bg-white rounded-full"></div>
                   </div>
                 </div>`,
          iconSize: [40, 40], iconAnchor: [20, 20]
        }),
        zIndexOffset: 1000
      }).addTo(mapInstance.current);
    } else {
      markersRef.current.user.setLatLng([lat, lng]);
    }
    
    if (autoCenterRef.current) {
      mapInstance.current.setView([lat, lng], 18, { animate: true, duration: 0.3 });
    }
  };

  const processNavigationUpdate = (lat, lng, speedMps) => {
    const currentRouteData = routeDataRef.current;
    if (!currentRouteData) return;
    
    updateUserLocationMarker(lat, lng);
    
    const mph = Math.round((speedMps || 0) * 2.23694);

    setNavState(prev => {
      const steps = currentRouteData.steps || [];
      let nextStepIdx = prev.currentStepIndex;

      if (nextStepIdx < steps.length) {
        const targetCoords = steps[nextStepIdx].maneuver.location;
        const distanceToTurn = getDistance(lat, lng, targetCoords[1], targetCoords[0]);
        if (distanceToTurn < 40) { 
          nextStepIdx = Math.min(nextStepIdx + 1, steps.length - 1);
        }
      }

      const safeTotalCoords = Math.max(1, currentRouteData.geometry?.coordinates?.length - 1 || 1);
      const progressRatio = prev.isSimulating 
        ? Math.min(1, simIndexRef.current / safeTotalCoords)
        : 1 - (prev.remainingDistance / Math.max(1, currentRouteData.distance || 1)); 
      
      const remainingDist = Math.max(0, currentRouteData.distance * (1 - progressRatio));
      const remainingTime = Math.max(0, currentRouteData.duration * (1 - progressRatio));

      const currentStep = steps[nextStepIdx];
      const newInstruction = currentStep?.maneuver?.instruction || 'Arrive at destination';

      if (newInstruction !== prev.currentInstruction) {
        speakInstruction(newInstruction);
      }

      return {
        ...prev,
        currentStepIndex: nextStepIdx,
        currentInstruction: newInstruction,
        remainingDistance: remainingDist,
        remainingTime: remainingTime,
        currentSpeedMph: mph
      };
    });
  };

  const startSimulationLoop = (speedMultiplier) => {
    if (simulationTimer.current) clearInterval(simulationTimer.current);
    const currentRouteData = routeDataRef.current;
    if (!currentRouteData || !currentRouteData.geometry) return;

    const coords = currentRouteData.geometry.coordinates; 
    const baseIntervalMs = 250; 
    const stepAdvance = Math.max(1, Math.round(speedMultiplier / 2));

    simulationTimer.current = setInterval(() => {
      const currentIdx = simIndexRef.current;
      if (currentIdx >= coords.length - 1) {
        setNavState(prev => ({ ...prev, currentInstruction: "You have arrived at your destination!", remainingDistance: 0, remainingTime: 0 }));
        speakInstruction("You have arrived at your destination.");
        clearInterval(simulationTimer.current);
        setTimeout(() => stopNavigation(), 4000);
        return;
      }

      const nextIdx = Math.min(currentIdx + stepAdvance, coords.length - 1);
      simIndexRef.current = nextIdx;
      
      const [lng, lat] = coords[nextIdx];
      const fakeSpeed = travelModeRef.current === 'driving' ? 15 + (speedMultiplier*2) : 2 + speedMultiplier; 
      processNavigationUpdate(lat, lng, fakeSpeed);
    }, baseIntervalMs);
  };

  const startNavigation = async (simulate = false) => {
    const currentRouteData = routeDataRef.current;
    if (!currentRouteData || !currentRouteData.geometry) return;
    
    setRouteError(''); setGpsWarning(''); setLocationWarning('');

    if (!simulate) {
      if (typeof navigator === 'undefined' || !('geolocation' in navigator)) { 
        setGpsWarning("Geolocation API is unsupported by your browser."); 
        return; 
      }
      try {
        const position = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: false, maximumAge: 15000, timeout: 10000 });
        });

        const { latitude, longitude } = position.coords;
        const coords = currentRouteData.geometry.coordinates;
        let minDistance = Infinity;
        const stepSize = Math.max(1, Math.floor(coords.length / 50));
        
        for (let i = 0; i < coords.length; i += stepSize) {
          const dist = getDistance(latitude, longitude, coords[i][1], coords[i][0]);
          if (dist < minDistance) minDistance = dist;
        }

        if (minDistance > 10000) {
          setLocationWarning("Your physical location is over 6 miles away from this route. Search a route closer to you, or use Simulate mode.");
          return;
        }
      } catch (error) {
         setGpsWarning("Browser geolocation is blocked. Switch to 'Simulate' mode to test running the path instantly!");
         return; 
      }
    }

    setAutoCenter(true);
    setNavState({
      isActive: true,
      isSimulating: simulate,
      currentStepIndex: 0,
      remainingDistance: currentRouteData.distance,
      remainingTime: currentRouteData.duration,
      eta: calculateETA(currentRouteData.duration),
      currentInstruction: currentRouteData.steps?.[0]?.maneuver?.instruction || 'Head towards destination',
      simSpeed: 10,
      currentSpeedMph: 0
    });
    
    speakInstruction(currentRouteData.steps?.[0]?.maneuver?.instruction || 'Starting route navigation');
    saveRouteToHistory(currentRouteData, waypointsRef.current);

    if (simulate) {
      simIndexRef.current = 0;
      startSimulationLoop(10); 
    } else {
      watchIdRef.current = navigator.geolocation.watchPosition(
        (position) => {
            const { latitude, longitude, speed } = position.coords;
            processNavigationUpdate(latitude, longitude, speed || 0);
        },
        (error) => {
            setGpsWarning("Lost GPS connection. Switch to 'Simulate' mode to test the path.");
            stopNavigation();
        },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
      );
    }
  };

  // Keep Session Active in LocalStorage
  useEffect(() => {
    if (navState.isActive) {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('activeRouteSession', JSON.stringify({ waypoints, travelMode, isSimulating: navState.isSimulating }));
      }
    } else {
      if (typeof window !== 'undefined') window.localStorage.removeItem('activeRouteSession');
    }
  }, [navState.isActive, navState.isSimulating, waypoints, travelMode]);

  const stopNavigation = () => {
    if (simulationTimer.current) { clearInterval(simulationTimer.current); simulationTimer.current = null; }
    if (watchIdRef.current && typeof navigator !== 'undefined' && navigator.geolocation) { 
      navigator.geolocation.clearWatch(watchIdRef.current); watchIdRef.current = null; 
    }
    if (markersRef.current.user) { markersRef.current.user?.remove?.(); markersRef.current.user = null; }
    
    setNavState(prev => ({ ...prev, isActive: false, isSimulating: false }));
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try { window.speechSynthesis.cancel(); } catch(e) {}
    }
    
    if (mapInstance.current && polylineRef.current) {
      try { mapInstance.current.fitBounds(polylineRef.current.getBounds(), { padding: [50, 50], animate: true }); } catch (e) { }
    }
  };

  // --- ADVANCED FEATURES (Save, Export, Share, Optimize) ---
  const saveRouteToHistory = (data, wps) => {
    const routeEntry = { id: Date.now(), name: data.name, waypoints: wps, distance: data.distance, date: new Date().toLocaleDateString() };
    setRouteHistory(prev => {
      const safePrev = Array.isArray(prev) ? prev : [];
      const newHist = [routeEntry, ...safePrev.filter(r => r && r.name !== data.name)]; 
      return newHist.slice(0, 8); 
    });
  };

  const toggleSaveRoute = () => {
    if (!routeData) return;
    const safeSaved = Array.isArray(savedRoutes) ? savedRoutes : [];
    const isSaved = safeSaved.some(r => r && r.name === routeData.name);
    if (isSaved) {
      setSavedRoutes(safeSaved.filter(r => r && r.name !== routeData.name));
    } else {
      setSavedRoutes([{ id: Date.now(), name: routeData.name, waypoints }, ...safeSaved]);
    }
  };

  const loadSavedRoute = (routeEntry) => {
    if (routeEntry && Array.isArray(routeEntry.waypoints)) {
      setWaypoints(routeEntry.waypoints);
      setActiveTab('plan');
    }
  };

  const shareRoute = () => {
    const wpsStr = JSON.stringify(waypoints.filter(w => w.lat));
    const url = `${window.location.origin}${window.location.pathname}#route=${btoa(wpsStr)}`;
    navigator.clipboard.writeText(url);
    alert("Route URL copied to clipboard!");
  };

  const exportGPX = () => {
    if (!routeData || !routeData.geometry) return;
    let gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="GlobalRouteNav">\n  <trk>\n    <name>${routeData.name}</name>\n    <trkseg>\n`;
    routeData.geometry.coordinates.forEach(([lng, lat]) => { gpx += `      <trkpt lat="${lat}" lon="${lng}"></trkpt>\n`; });
    gpx += `    </trkseg>\n  </trk>\n</gpx>`;
    
    const blob = new Blob([gpx], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${routeData.name.replace(/\s+/g, '_')}.gpx`;
    a.click();
  };

  const optimizeRoute = async () => {
    const validWps = waypoints.filter(wp => wp.lat !== null && wp.lng !== null);
    if (validWps.length < 3) return alert("Need at least 3 points to optimize.");
    
    setLoadingRoute(true);
    try {
      const coords = validWps.map(wp => `${wp.lng},${wp.lat}`).join(';');
      const url = `https://router.project-osrm.org/trip/v1/car/${coords}?source=first&destination=last&roundtrip=false`;
      const res = await fetch(url);
      const data = await res.json();
      
      if (data.code === 'Ok' && data.waypoints) {
        const optimizedWps = [];
        data.waypoints.sort((a,b) => a.waypoint_index - b.waypoint_index).forEach(wp => {
           const original = validWps.find(v => Math.abs(v.lat - wp.location[1]) < 0.001 && Math.abs(v.lng - wp.location[0]) < 0.001);
           if (original) optimizedWps.push(original);
        });
        if (optimizedWps.length === validWps.length) {
          setWaypoints(optimizedWps);
        }
      }
    } catch(e) {}
    finally { setLoadingRoute(false); }
  };

  const centerOnUser = () => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (mapInstance.current) {
          mapInstance.current.setView([pos.coords.latitude, pos.coords.longitude], 15, { animate: true });
        }
      },
      (err) => {}
    );
  };


  // --- RENDERERS ---
  const renderPlanTab = () => (
    <div className="flex-1 overflow-y-auto bg-slate-50/50 dark:bg-slate-900/50 relative flex flex-col">
      <div className="p-4 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="space-y-3 relative">
          <div className="absolute left-[22px] top-[24px] bottom-[24px] w-0.5 bg-slate-200 dark:bg-slate-700 z-0"></div>

          {waypoints.map((wp, idx) => {
            const isStart = idx === 0;
            const isEnd = idx === waypoints.length - 1;
            return (
              <div key={wp.id} className="flex items-center gap-2 relative z-10">
                <div className="w-5 flex flex-col items-center justify-center gap-1 shrink-0">
                   {!isStart && <button onClick={()=>moveWaypoint(idx, -1)} className="text-slate-300 hover:text-slate-500"><ChevronRight className="w-4 h-4 -rotate-90" /></button>}
                   <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white shadow-sm ${isStart ? 'bg-blue-500' : isEnd ? 'bg-red-500' : 'bg-amber-500'}`}>
                     {isStart ? 'A' : isEnd ? 'B' : idx}
                   </div>
                   {!isEnd && <button onClick={()=>moveWaypoint(idx, 1)} className="text-slate-300 hover:text-slate-500"><ChevronRight className="w-4 h-4 rotate-90" /></button>}
                </div>

                <div className="flex-1 relative">
                  <input
                    type="text" 
                    placeholder={isStart ? "Start point" : isEnd ? "Destination" : "Add stop..."}
                    value={activeInputIdx === idx ? searchQuery : wp.label}
                    onChange={(e) => { setActiveInputIdx(idx); setSearchQuery(e.target.value); }}
                    onFocus={() => { setActiveInputIdx(idx); setSearchQuery(wp.label); }}
                    className="w-full bg-slate-100 dark:bg-slate-800 border border-transparent rounded-lg px-4 py-2.5 text-sm focus:border-blue-500 focus:bg-white dark:focus:bg-slate-900 outline-none transition-all pr-8"
                  />
                  {wp.label && activeInputIdx !== idx && (
                    <button onClick={() => {
                        const newWps = [...waypoints]; newWps[idx] = { ...newWps[idx], lat:null, lng:null, label:'' }; setWaypoints(newWps);
                      }} 
                      className="absolute right-2 top-3 text-slate-400 hover:text-red-500"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
                
                {waypoints.length > 2 && (
                  <button onClick={() => removeWaypoint(idx)} className="text-slate-400 hover:text-red-500 p-2">
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex gap-2 mt-4 ml-7">
          <button onClick={addWaypoint} className="flex items-center gap-1 text-sm font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400">
            <Plus className="w-4 h-4" /> Add Stop
          </button>
          {waypoints.length > 2 && (
            <button onClick={optimizeRoute} className="flex items-center gap-1 text-sm font-medium text-amber-600 hover:text-amber-700 dark:text-amber-400 ml-4">
              <Zap className="w-4 h-4" /> Optimize Order
            </button>
          )}
        </div>
      </div>

      {activeInputIdx !== null && searchResults.length > 0 && (
        <div className="absolute left-10 right-4 top-14 bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-100 dark:border-slate-700 z-50 overflow-hidden max-h-60 overflow-y-auto">
          {searchResults.map((result) => (
            <button key={result.place_id} onClick={() => handleSelectSearchResult(result)} className="w-full text-left px-4 py-3 border-b border-slate-100 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 flex items-start gap-3">
              <MapPin className="w-4 h-4 mt-1 text-slate-400 shrink-0" />
              <span className="text-sm line-clamp-2">{result.display_name}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 relative">
        {loadingRoute && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/80 dark:bg-slate-900/80 z-10 backdrop-blur-sm">
            <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
            <p className="text-sm font-medium animate-pulse">Calculating optimal route...</p>
          </div>
        )}

        {routeError && (
          <div className="p-6 text-center animate-in fade-in mt-10">
            <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-3" />
            <p className="text-red-500 font-medium">{routeError}</p>
          </div>
        )}

        {routeData && !loadingRoute && (
          <div className="animate-in fade-in duration-500">
            <div className="bg-blue-600 text-white p-6 shadow-md relative overflow-hidden">
              <div className="absolute right-0 top-0 opacity-10 transform translate-x-4 -translate-y-4">
                <Route className="w-48 h-48" />
              </div>

              <div className="relative z-10">
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <div className="text-4xl font-bold tracking-tight mb-1">
                      {formatDuration(routeData.duration)}
                    </div>
                    <div className="text-blue-100 font-medium flex items-center gap-2 mb-1">
                      <Navigation className="w-4 h-4" />
                      {formatDistance(routeData.distance, true)} ({formatDistance(routeData.distance, false)})
                    </div>
                    <div className="text-blue-200 text-sm flex items-center gap-2 mt-2">
                       <span>ETA {calculateETA(routeData.duration)}</span>
                       <span className="w-1 h-1 bg-blue-300 rounded-full"></span>
                       <span>{waypoints.filter(w=>w.lat).length - 2} stops</span>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 mb-4">
                  <button onClick={toggleSaveRoute} className={`px-3 py-1.5 rounded-full text-xs font-bold flex items-center gap-1 transition-colors ${Array.isArray(savedRoutes) && savedRoutes.some(r=> r && r.name === routeData.name) ? 'bg-amber-400 text-amber-900' : 'bg-blue-700 text-white hover:bg-blue-800'}`}>
                    <Bookmark className="w-3.5 h-3.5 fill-current" /> Save
                  </button>
                  <button onClick={shareRoute} className="px-3 py-1.5 bg-blue-700 hover:bg-blue-800 text-white rounded-full text-xs font-bold flex items-center gap-1">
                    <Share2 className="w-3.5 h-3.5" /> Share
                  </button>
                  <button onClick={exportGPX} className="px-3 py-1.5 bg-blue-700 hover:bg-blue-800 text-white rounded-full text-xs font-bold flex items-center gap-1">
                    <Download className="w-3.5 h-3.5" /> GPX
                  </button>
                </div>

                <div className="flex gap-2">
                  <button onClick={() => startNavigation(false)} className="flex-1 bg-white text-blue-600 hover:bg-slate-100 py-3.5 rounded-xl font-bold flex items-center justify-center gap-2 shadow-sm text-lg">
                    <Navigation className="w-5 h-5 fill-current" /> GO
                  </button>
                  <button onClick={() => startNavigation(true)} className="flex-1 bg-blue-700 text-white hover:bg-blue-800 border border-blue-500 py-3.5 rounded-xl font-bold flex items-center justify-center gap-2 shadow-sm">
                    <Play className="w-5 h-5 fill-current" /> Simulate
                  </button>
                </div>
              </div>
            </div>

            <div className="p-4">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-4 ml-2">Turn-by-Turn Directions</h3>
              <div className="space-y-1 pb-10">
                {routeData.steps && routeData.steps.map((step, idx) => {
                  const isLast = idx === routeData.steps.length - 1;
                  return (
                    <div key={`step-${idx}`} onClick={() => zoomToStep(step?.maneuver?.location)} className="group flex gap-4 p-3 hover:bg-white dark:hover:bg-slate-800 rounded-xl transition-all cursor-pointer hover:shadow-sm">
                      <div className="flex flex-col items-center shrink-0">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center ${isLast ? 'bg-green-100 text-green-600' : 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300'} group-hover:scale-110 transition-transform`}>
                          {isLast ? <CheckCircle className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </div>
                        {!isLast && <div className="w-0.5 h-full bg-slate-200 dark:bg-slate-700 mt-2 group-hover:bg-blue-200 dark:group-hover:bg-blue-800 transition-colors"></div>}
                      </div>
                      <div className="pb-4 pt-1 flex-1">
                        <p className="text-sm font-medium leading-relaxed">{step?.maneuver?.instruction || `Continue on route`}</p>
                        {step?.distance > 0 && <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{formatDistance(step.distance, true)}</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {!routeData && !loadingRoute && (
           <div className="h-full flex flex-col items-center justify-center p-8 opacity-20 pointer-events-none mt-20">
             <MapIcon className="w-32 h-32" />
             <p className="font-bold text-xl mt-4">Plan Your Route</p>
           </div>
        )}
      </div>
    </div>
  );

  const renderHistoryTab = () => (
    <div className="flex-1 overflow-y-auto bg-slate-50 dark:bg-slate-900 p-4">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-lg font-bold flex items-center gap-2"><History className="w-5 h-5"/> Recent Routes</h2>
        <button onClick={() => setRouteHistory([])} className="text-xs font-bold text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 px-2 py-1 rounded">Clear</button>
      </div>
      {!Array.isArray(routeHistory) || routeHistory.length === 0 ? (
        <p className="text-slate-500 text-sm text-center mt-10">No recent routes.</p>
      ) : (
        <div className="space-y-3">
          {routeHistory.map((route, i) => {
            if (!route) return null;
            return (
              <div key={`hist-${route.id || i}`} onClick={() => loadSavedRoute(route)} className="bg-white dark:bg-slate-800 p-4 rounded-xl shadow-sm hover:shadow-md cursor-pointer border border-slate-100 dark:border-slate-700 transition-all">
                <p className="font-bold text-sm mb-1 line-clamp-1">{route.name || 'Unnamed Route'}</p>
                <div className="flex justify-between text-xs text-slate-500">
                   <span>{route.date || ''}</span>
                   <span>{formatDistance(route.distance)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  const renderSavedTab = () => (
    <div className="flex-1 overflow-y-auto bg-slate-50 dark:bg-slate-900 p-4">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-lg font-bold flex items-center gap-2 text-amber-500"><Bookmark className="w-5 h-5 fill-current"/> Saved Trips</h2>
      </div>
      {!Array.isArray(savedRoutes) || savedRoutes.length === 0 ? (
        <p className="text-slate-500 text-sm text-center mt-10">You haven't saved any routes yet.</p>
      ) : (
        <div className="space-y-3">
          {savedRoutes.map((route, i) => {
            if (!route) return null;
            return (
              <div key={`saved-${route.id || i}`} className="bg-white dark:bg-slate-800 p-4 rounded-xl shadow-sm border border-amber-100 dark:border-amber-900/30 relative group">
                <div className="cursor-pointer pr-8" onClick={() => loadSavedRoute(route)}>
                  <p className="font-bold text-sm mb-1 line-clamp-2">{route.name || 'Unnamed Route'}</p>
                  <p className="text-xs text-slate-500">{Array.isArray(route.waypoints) ? route.waypoints.length : 0} Stops</p>
                </div>
                <button 
                  onClick={(e) => { e.stopPropagation(); setSavedRoutes(prev => Array.isArray(prev) ? prev.filter(r => r && r.id !== route.id) : []); }}
                  className="absolute right-3 top-3 p-2 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <div className="flex flex-col md:flex-row h-screen w-full bg-slate-50 dark:bg-slate-900 text-slate-800 dark:text-slate-200 font-sans overflow-hidden transition-colors duration-300 relative">
      
      <style dangerouslySetInnerHTML={{__html: `
        .leaflet-container { font-family: inherit; z-index: 10; }
        .dark .map-tiles { filter: invert(100%) hue-rotate(180deg) brightness(95%) contrast(90%); }
        .leaflet-control-zoom a { color: #1e293b !important; background: #fff !important; border-color: #cbd5e1 !important; }
        .dark .leaflet-control-zoom a { color: #e2e8f0 !important; background: #1e293b !important; border-color: #334155 !important; }
        .navigation-user-marker { transition: transform 0.25s linear; }
      `}} />

      {/* OFFLINE INDICATOR */}
      {isOffline && (
        <div className="absolute top-0 left-0 right-0 z-[200] bg-red-600 text-white text-xs font-bold text-center py-1.5 flex items-center justify-center gap-2">
          <WifiOff className="w-3.5 h-3.5" /> No Internet Connection
        </div>
      )}

      {/* POPUP MODALS */}
      {locationWarning && (
        <div className="absolute inset-0 z-[100] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-slate-800 rounded-3xl shadow-2xl max-w-md w-full p-8 text-center animate-in zoom-in-95 border border-slate-100 dark:border-slate-700">
            <div className="w-20 h-20 bg-red-100 dark:bg-red-900/30 text-red-500 rounded-full flex items-center justify-center mx-auto mb-6"><MapPin className="w-10 h-10" /></div>
            <h2 className="text-2xl font-black mb-3">Too Far From Route</h2>
            <p className="text-slate-600 dark:text-slate-300 mb-8">{locationWarning}</p>
            <button onClick={() => setLocationWarning('')} className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3.5 px-4 rounded-xl transition-colors">Okay, got it</button>
          </div>
        </div>
      )}

      {/* ACTIVE NAVIGATION OVERLAY */}
      {navState.isActive && (
        <div className="absolute inset-0 z-50 flex flex-col pointer-events-none">
          
          {/* Trip Progress Bar */}
          <div className="h-1.5 bg-slate-200 dark:bg-slate-800 w-full relative">
            <div 
              className="absolute top-0 left-0 h-full bg-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.8)] transition-all duration-1000"
              style={{ width: `${Math.min(100, Math.max(0, 100 - (navState.remainingDistance / (routeData?.distance || 1) * 100)))}%` }}
            ></div>
          </div>

          {/* Top Big Turn Instruction */}
          <div className="bg-green-600 dark:bg-green-700 text-white p-5 md:p-6 shadow-2xl pointer-events-auto rounded-b-3xl">
            <div className="max-w-4xl mx-auto flex items-center gap-4 md:gap-6">
               <div className="bg-green-800/50 p-3 md:p-4 rounded-2xl">
                  <Compass className="w-8 h-8 md:w-12 md:h-12 animate-pulse" />
               </div>
               <div className="flex-1">
                  <h2 className="text-[10px] md:text-sm font-bold text-green-200 uppercase tracking-widest mb-1">Upcoming Turn</h2>
                  <p className="text-xl md:text-4xl font-extrabold tracking-tight leading-tight line-clamp-2">
                    {navState.currentInstruction || "Proceed to route"}
                  </p>
               </div>
               {/* Nav Controls */}
               <div className="flex flex-col gap-2">
                 <button onClick={()=>setVoiceEnabled(!voiceEnabled)} className={`p-3 rounded-full transition-colors ${voiceEnabled ? 'bg-green-500 hover:bg-green-400' : 'bg-green-800 text-slate-300 hover:bg-green-900'}`}>
                   {voiceEnabled ? <Volume2 className="w-5 h-5"/> : <VolumeX className="w-5 h-5"/>}
                 </button>
                 <button onClick={()=>setAutoCenter(!autoCenter)} className={`p-3 rounded-full transition-colors ${autoCenter ? 'bg-blue-500 hover:bg-blue-400 text-white' : 'bg-slate-100 text-slate-800'}`} title="Auto-center map">
                   <LocateFixed className="w-5 h-5"/>
                 </button>
               </div>
            </div>
          </div>

          <div className="flex-1"></div>

          {/* Simulation Tools */}
          {navState.isSimulating && (
            <div className="self-center mb-4 pointer-events-auto bg-slate-950/90 text-white px-5 py-3 rounded-2xl shadow-xl flex items-center gap-4 border border-slate-800 backdrop-blur-md">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2"><FastForward className="w-4 h-4 text-blue-400" /> Speed</span>
              <div className="flex gap-1.5">
                {[1, 5, 10, 25, 50].map(s => (
                  <button key={s} onClick={() => changeSimulationSpeed(s)} className={`px-2.5 py-1 text-xs font-bold rounded-lg transition-all ${navState.simSpeed === s ? 'bg-blue-500 text-white' : 'bg-slate-800 hover:bg-slate-700'}`}>{s}x</button>
                ))}
              </div>
            </div>
          )}

          {/* Bottom Stats Dashboard */}
          <div className="bg-white dark:bg-slate-800 shadow-[0_-10px_40px_rgba(0,0,0,0.1)] p-4 md:p-6 pointer-events-auto border-t border-slate-200 dark:border-slate-700">
            <div className="max-w-4xl mx-auto flex justify-between items-center gap-2">
              <div className="flex items-center gap-6 md:gap-10">
                 {/* ETA / Time */}
                 <div>
                    <p className="text-3xl md:text-5xl font-black text-green-600 dark:text-green-500 tracking-tight">
                      {formatDuration(navState.remainingTime).split(' ')[0]}
                      <span className="text-sm md:text-xl text-slate-500 dark:text-slate-400 font-medium ml-1">
                        {formatDuration(navState.remainingTime).split(' ').slice(1).join(' ')}
                      </span>
                    </p>
                    <p className="text-sm font-medium text-slate-500 mt-1">ETA <span className="font-bold text-slate-800 dark:text-white">{navState.eta}</span></p>
                 </div>
                 
                 <div className="h-10 w-px bg-slate-200 dark:bg-slate-700 hidden sm:block"></div>
                 
                 {/* Distance & Speed */}
                 <div className="hidden sm:block">
                    <p className="text-2xl font-bold text-slate-700 dark:text-slate-200">{formatDistance(navState.remainingDistance, true)}</p>
                    <p className="text-sm font-medium text-slate-500 mt-1">Remaining</p>
                 </div>

                 <div className="hidden md:flex flex-col items-center bg-slate-100 dark:bg-slate-900 rounded-xl px-4 py-2 border border-slate-200 dark:border-slate-700">
                    <span className="text-2xl font-black text-slate-800 dark:text-white">{navState.currentSpeedMph}</span>
                    <span className="text-[10px] uppercase font-bold text-slate-400">MPH</span>
                 </div>
              </div>

              <button onClick={stopNavigation} className="bg-red-500 hover:bg-red-600 text-white px-6 md:px-8 py-4 rounded-xl font-bold text-lg shadow-lg hover:shadow-red-500/30 transition-all flex items-center justify-center gap-2">
                <X className="w-5 h-5" /> <span className="hidden sm:inline">Exit</span>
              </button>
            </div>
          </div>
        </div>
      )}


      {/* MAIN UI SIDEBAR */}
      <div className={`w-full md:w-[420px] h-[50vh] md:h-screen flex flex-col bg-white dark:bg-slate-900 shadow-2xl z-20 transition-transform duration-500 ${navState.isActive ? '-translate-x-full absolute opacity-0' : 'relative'}`}>
        
        {/* Header */}
        <div className="px-6 py-5 border-b border-slate-200 dark:border-slate-800 shrink-0 flex justify-between items-center bg-white dark:bg-slate-900">
          <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400">
            <Navigation className="w-6 h-6 fill-current" />
            <h1 className="text-xl font-black tracking-tight text-slate-900 dark:text-white">RouteNav <span className="text-blue-500">Pro</span></h1>
          </div>
          <button onClick={() => setDarkMode(!darkMode)} className="p-2 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
            {darkMode ? <Sun className="w-5 h-5 text-amber-400" /> : <Moon className="w-5 h-5 text-slate-600" />}
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 shrink-0">
          {[
            { id: 'plan', icon: Route, label: 'Plan' },
            { id: 'saved', icon: Bookmark, label: 'Saved' },
            { id: 'history', icon: History, label: 'History' }
          ].map(tab => {
            const TabIcon = tab.icon;
            return (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)} className={`flex-1 py-3 text-sm font-bold flex items-center justify-center gap-2 border-b-2 transition-colors ${activeTab === tab.id ? 'border-blue-500 text-blue-600 dark:text-blue-400 bg-white dark:bg-slate-800' : 'border-transparent text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>
                <TabIcon className="w-4 h-4" /> {tab.label}
              </button>
            );
          })}
        </div>

        {/* Transport Modes (Only in Plan tab) */}
        {activeTab === 'plan' && (
          <div className="px-4 pt-4 shrink-0 bg-white dark:bg-slate-900">
             <div className="flex bg-slate-100 dark:bg-slate-800 p-1 rounded-xl">
              {[
                { id: 'driving', icon: Car, label: 'Drive' },
                { id: 'walking', icon: Footprints, label: 'Walk' },
                { id: 'cycling', icon: Bike, label: 'Cycle' }
              ].map(({ id, icon: Icon, label }) => (
                <button key={id} onClick={() => setTravelMode(id)} className={`flex-1 flex items-center justify-center gap-2 py-2 text-sm font-bold rounded-lg transition-all ${travelMode === id ? 'bg-white dark:bg-slate-700 shadow-sm text-blue-600 dark:text-blue-400' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}>
                  <Icon className="w-4 h-4" /> <span className="hidden sm:inline">{label}</span>
                </button>
              ))}
            </div>
            
            {gpsWarning && (
              <div className="mt-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 rounded-lg flex items-start gap-2 animate-in fade-in">
                <AlertCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-700 dark:text-amber-400">{gpsWarning}</p>
              </div>
            )}
          </div>
        )}

        {/* Dynamic Tab Content */}
        {activeTab === 'plan' && renderPlanTab()}
        {activeTab === 'history' && renderHistoryTab()}
        {activeTab === 'saved' && renderSavedTab()}

      </div>

      {/* MAP VIEWPORT */}
      <div className="flex-1 relative bg-slate-200 dark:bg-slate-800 h-[50vh] md:h-screen">
        <div id="map" ref={mapRef} className="w-full h-full absolute inset-0 z-0"></div>
        
        {/* Floating Map Controls */}
        <div className="absolute bottom-6 right-6 z-10 flex flex-col gap-2">
           <button onClick={centerOnUser} className="w-12 h-12 bg-white dark:bg-slate-800 rounded-full shadow-lg border border-slate-200 dark:border-slate-700 flex items-center justify-center text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-slate-700 transition-colors" title="Find my location">
             <LocateFixed className="w-6 h-6" />
           </button>
        </div>

        {!isMapLoaded && !mapLoadError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-100 dark:bg-slate-900 z-10">
            <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
            <p className="text-slate-500 font-bold">Initializing Map Engine...</p>
          </div>
        )}

        {mapLoadError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-100 dark:bg-slate-900 z-10 text-red-500 p-8 text-center">
            <AlertCircle className="w-12 h-12 mb-4" />
            <p className="font-bold text-lg">{mapLoadError}</p>
          </div>
        )}
      </div>

    </div>
  );
}
