import React, { useState, useEffect, useRef } from 'react';
import { 
  Map as MapIcon, Search, Navigation, Moon, Sun, 
  MapPin, Route, ChevronRight, X, AlertCircle, 
  Car, Footprints, Bike, ArrowRightLeft, MousePointerClick, 
  CheckCircle, Play, Compass, FastForward
} from 'lucide-react';

// --- CONFIGURATION & HELPERS ---
const TILE_URL = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

const ROUTING_PROFILES = { driving: 'car', walking: 'foot', cycling: 'bike' };

const formatDistance = (meters, useMiles = true) => {
  if (useMiles) {
    const miles = meters * 0.000621371;
    if (miles < 0.1) return `${Math.round(meters * 3.28084)} ft`;
    return `${miles.toFixed(1)} mi`;
  }
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
};

const formatDuration = (seconds) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h} hr ${m} min`;
  return `${m} min`;
};

const calculateETA = (seconds) => {
  const date = new Date(Date.now() + seconds * 1000);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

// Haversine formula to calculate distance between two lat/lng points
const getDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371e3; // Earth radius in meters
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * rad) * Math.cos(lat2 * rad) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c; // in meters
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

// --- MAIN APPLICATION COMPONENT ---
export default function GlobalRouteNavigator() {
  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const markersRef = useRef({ start: null, end: null, user: null });
  const polylineRef = useRef(null);
  const decoratorRef = useRef(null);
  const LRef = useRef(null);

  // Core State
  const [darkMode, setDarkMode] = useState(false);
  const [startPoint, setStartPoint] = useState(null);
  const [endPoint, setEndPoint] = useState(null);
  const [travelMode, setTravelMode] = useState('driving');
  const [routeData, setRouteData] = useState(null);
  const [routeError, setRouteError] = useState('');
  const [loadingRoute, setLoadingRoute] = useState(false);
  
  // Search State
  const [activeInput, setActiveInput] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const debouncedSearch = useDebounce(searchQuery, 400);

  // Navigation State
  const [navState, setNavState] = useState({
    isActive: false,
    isSimulating: false,
    currentStepIndex: 0,
    remainingDistance: 0,
    remainingTime: 0,
    eta: '',
    currentInstruction: null,
    simSpeed: 10 // default speed multiplier (e.g. 10x)
  });
  const simulationTimer = useRef(null);
  const watchIdRef = useRef(null);
  const simIndexRef = useRef(0); // tracking simulation tick position

  // Friendly non-intrusive warning for Geolocation permission blocking
  const [gpsWarning, setGpsWarning] = useState('');
  
  // Popup warning for when the user is too far from the route
  const [locationWarning, setLocationWarning] = useState('');

  // --- FORCE RE-RENDERS & SYNC LIFECYCLES ---
  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const [mapLoadError, setMapLoadError] = useState(''); 
  
  // Synchronized State References to cure all stale closure bugs in intervals & callbacks
  const navStateRef = useRef(navState);
  const routeDataRef = useRef(routeData);
  const travelModeRef = useRef(travelMode);

  useEffect(() => { navStateRef.current = navState; }, [navState]);
  useEffect(() => { routeDataRef.current = routeData; }, [routeData]);
  useEffect(() => { travelModeRef.current = travelMode; }, [travelMode]);

  // Initialize Dark Mode
  useEffect(() => {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) setDarkMode(true);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    darkMode ? root.classList.add('dark') : root.classList.remove('dark');
  }, [darkMode]);

  // Load Leaflet JS, CSS & Plugins dynamically in correct parallel sequence
  useEffect(() => {
    let isMounted = true;
    
    const loadAsset = (url, type, id) => new Promise((resolve, reject) => {
      if (document.getElementById(id)) return resolve();
      
      let element = document.createElement(type === 'css' ? 'link' : 'script');
      element.id = id;
      
      if (type === 'css') {
        element.rel = 'stylesheet';
        element.href = url;
      } else {
        element.src = url;
      }
      
      element.onload = resolve;
      element.onerror = () => reject(new Error(`Failed to load ${url}`));
      document.head.appendChild(element);
    });

    const initMapDependencies = async () => {
      try {
        // Parallel Core Assets Pull from Global Cloudflare CDN
        await Promise.all([
          loadAsset('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css', 'css', 'leaflet-css'),
          loadAsset('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js', 'script', 'leaflet-js')
        ]);
        
        if (isMounted) {
          LRef.current = window.L;
          initMap(); 
        }

        // Parallel background plugin loader (Arrow Decors)
        loadAsset('https://unpkg.com/leaflet-polylinedecorator@1.6.4/dist/leaflet.polylineDecorator.js', 'script', 'leaflet-decorator-js')
          .catch(e => console.warn("Polyline decorator helper is unavailable.", e));

      } catch (err) {
        console.error("Map rendering assets failed:", err);
        if (isMounted) setMapLoadError('Could not render mapping assets. Please verify your connection.');
      }
    };

    initMapDependencies();

    return () => { 
      isMounted = false; 
      if (mapInstance.current) {
        mapInstance.current.remove();
        mapInstance.current = null;
      }
    };
  }, []);

  // Initialize Map
  const initMap = () => {
    if (!mapRef.current || !LRef.current) return;
    const L = LRef.current;

    if (mapInstance.current) {
      mapInstance.current.remove();
      mapInstance.current = null;
    }
    
    if (mapRef.current._leaflet_id) {
      mapRef.current._leaflet_id = null;
    }

    mapInstance.current = L.map(mapRef.current, {
      zoomControl: false,
      tap: false
    }).setView([39.8283, -98.5795], 4); 

    L.control.zoom({ position: 'topright' }).addTo(mapInstance.current);

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      className: 'map-tiles'
    }).addTo(mapInstance.current);

    mapInstance.current.on('click', (e) => {
       if (navStateRef.current.isActive) return;
       handleMapClick(e.latlng.lat, e.latlng.lng);
    });

    setIsMapLoaded(true);

    setTimeout(() => {
      if (mapInstance.current) {
        mapInstance.current.invalidateSize();
      }
    }, 250);
  };

  const handleMapClick = async (lat, lng) => {
    if (navStateRef.current.isActive) return; 

    let label = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`);
      const data = await res.json();
      if (data && data.display_name) {
        label = data.display_name.split(',').slice(0, 3).join(',').trim();
      }
    } catch (e) { console.error('Reverse Geocode failed:', e); }

    const point = { lat, lng, label };

    setStartPoint((prev) => {
      if (!prev) return point;
      setEndPoint((prevEnd) => {
        if (!prevEnd) return point;
        return point; 
      });
      return prev;
    });
  };

  // Autocomplete Search with AbortController to prevent race conditions
  useEffect(() => {
    let isActive = true;
    const controller = new AbortController();

    const fetchGeocode = async () => {
      if (!debouncedSearch || debouncedSearch.length < 3) {
        setSearchResults([]);
        setIsSearching(false);
        return;
      }
      setIsSearching(true);
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(debouncedSearch)}&limit=5`, {
          signal: controller.signal
        });
        const data = await res.json();
        if (isActive && Array.isArray(data)) setSearchResults(data);
      } catch (err) { 
        if (err.name !== 'AbortError') console.error('Geocoding error:', err); 
      } finally { 
        if (isActive) setIsSearching(false); 
      }
    };

    fetchGeocode();

    return () => {
      isActive = false;
      controller.abort();
    };
  }, [debouncedSearch]);

  // Routing Engine with AbortController to prevent API network thrashing
  useEffect(() => {
    let isActive = true;
    const controller = new AbortController();

    if (!startPoint || !endPoint) {
      setRouteData(null);
      clearMapDrawings();
      return;
    }
    
    // Prevent auto-rerouting while navigation is active
    if (navStateRef.current.isActive) return; 

    const fetchRoute = async () => {
      setLoadingRoute(true);
      setRouteError('');
      try {
        const profile = ROUTING_PROFILES[travelMode] || 'car';
        const url = `https://router.project-osrm.org/route/v1/${profile}/${startPoint.lng},${startPoint.lat};${endPoint.lng},${endPoint.lat}?overview=full&geometries=geojson&steps=true`;
        
        const res = await fetch(url, { signal: controller.signal });
        const data = await res.json();

        if (!isActive) return;

        if (data.code !== 'Ok') throw new Error(data.message || 'Could not map route.');

        const route = data.routes[0];
        // Safely extract steps avoiding undefined crashes
        const validSteps = route?.legs?.[0]?.steps?.filter(s => s.maneuver.instruction || s.name) || [];

        setRouteData({
          distance: route.distance,
          duration: route.duration,
          steps: validSteps,
          geometry: route.geometry
        });

        drawRoute(route.geometry);
      } catch (err) {
        if (!isActive || err.name === 'AbortError') return;
        setRouteError(err.message || 'Route planning failed.');
        setRouteData(null);
        clearMapDrawings();
      } finally {
        if (isActive) setLoadingRoute(false);
      }
    };

    fetchRoute();

    return () => {
      isActive = false;
      controller.abort();
    };
  }, [startPoint, endPoint, travelMode]);

  // Keyboard navigation closure triggers
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setActiveInput(null);
        setSearchResults([]);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Sync Markers
  useEffect(() => {
    if (!LRef.current || !mapInstance.current) return;
    const L = LRef.current;

    const createIcon = (color, svg) => L.divIcon({
      className: 'custom-map-marker',
      html: `<div style="background-color: ${color}; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.3); border: 2px solid white; transform: translate(-50%, -100%);">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${svg}</svg>
             </div>`,
      iconSize: [0, 0], iconAnchor: [0, 0]
    });

    if (markersRef.current.start) markersRef.current.start.remove();
    if (startPoint && !navState.isActive) { 
      markersRef.current.start = L.marker([startPoint.lat, startPoint.lng], {
        icon: createIcon('#3b82f6', '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>')
      }).addTo(mapInstance.current);
      if (!endPoint && !routeData) mapInstance.current.setView([startPoint.lat, startPoint.lng], 14, { animate: true });
    }

    if (markersRef.current.end) markersRef.current.end.remove();
    if (endPoint) {
      markersRef.current.end = L.marker([endPoint.lat, endPoint.lng], {
        icon: createIcon('#ef4444', '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle>')
      }).addTo(mapInstance.current);
      if (!startPoint && !routeData) mapInstance.current.setView([endPoint.lat, endPoint.lng], 14, { animate: true });
    }
  }, [startPoint, endPoint, navState.isActive, routeData]);

  const clearMapDrawings = () => {
    if (polylineRef.current) polylineRef.current.remove();
    if (decoratorRef.current) decoratorRef.current.remove();
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
        patterns: [
            { offset: '5%', repeat: '100px', symbol: L.Symbol.arrowHead({ pixelSize: 12, polygon: true, pathOptions: { fillOpacity: 1, weight: 0, color: '#ffffff' } }) }
        ]
      }).addTo(mapInstance.current);
    }

    if (!navState.isActive) {
      mapInstance.current.fitBounds(polylineRef.current.getBounds(), { padding: [50, 50], animate: true });
    }
  };

  const handleSelectSearchResult = (result) => {
    const point = {
      lat: parseFloat(result.lat),
      lng: parseFloat(result.lon),
      label: result.display_name.split(',').slice(0, 3).join(',').trim()
    };
    if (activeInput === 'start') setStartPoint(point);
    else if (activeInput === 'end') setEndPoint(point);

    setSearchQuery(''); setSearchResults([]); setActiveInput(null);
  };

  const swapLocations = () => {
    const temp = startPoint;
    setStartPoint(endPoint); setEndPoint(temp);
  };

  const clearRoute = () => {
    stopNavigation();
    setStartPoint(null); setEndPoint(null);
    setRouteData(null); setRouteError('');
    clearMapDrawings();
  };

  const zoomToStep = (coords) => {
    if (mapInstance.current && coords && !navState.isActive) {
      mapInstance.current.setView([coords[1], coords[0]], 18, { animate: true });
    }
  };

  // --- NAVIGATION & REAL-TIME TRACKING ENGINE ---
  
  const updateUserLocationMarker = (lat, lng) => {
    if (!LRef.current || !mapInstance.current) return;
    const L = LRef.current;

    if (!markersRef.current.user) {
      markersRef.current.user = L.marker([lat, lng], {
        icon: L.divIcon({
          className: 'navigation-user-marker',
          html: `<div class="relative flex items-center justify-center w-8 h-8">
                   <div class="absolute w-full h-full bg-blue-500 rounded-full animate-ping opacity-50"></div>
                   <div class="relative w-5 h-5 bg-blue-600 border-2 border-white rounded-full shadow-lg"></div>
                 </div>`,
          iconSize: [32, 32], iconAnchor: [16, 16]
        }),
        zIndexOffset: 1000
      }).addTo(mapInstance.current);
    } else {
      markersRef.current.user.setLatLng([lat, lng]);
    }
    
    mapInstance.current.setView([lat, lng], 18, { animate: true, duration: 0.3 });
  };

  const processNavigationUpdate = (lat, lng, speedFactor) => {
    const currentRouteData = routeDataRef.current;
    if (!currentRouteData) return;
    updateUserLocationMarker(lat, lng);

    setNavState(prev => {
      const steps = currentRouteData.steps;
      let nextStepIdx = prev.currentStepIndex;

      if (nextStepIdx < steps.length) {
        const targetCoords = steps[nextStepIdx].maneuver.location;
        const distanceToTurn = getDistance(lat, lng, targetCoords[1], targetCoords[0]);
        if (distanceToTurn < 40) { 
          nextStepIdx = Math.min(nextStepIdx + 1, steps.length - 1);
        }
      }

      const progressRatio = prev.isSimulating 
        ? Math.min(1, simIndexRef.current / Math.max(1, currentRouteData.geometry.coordinates.length - 1))
        : 0;
      
      const remainingDist = Math.max(0, currentRouteData.distance * (1 - progressRatio));
      const remainingTime = Math.max(0, currentRouteData.duration * (1 - progressRatio));

      const currentStep = steps[nextStepIdx];
      return {
        ...prev,
        currentStepIndex: nextStepIdx,
        currentInstruction: currentStep ? currentStep.maneuver.instruction : 'Arrive at destination',
        remainingDistance: remainingDist,
        remainingTime: remainingTime
      };
    });
  };

  const startSimulationLoop = (speedMultiplier) => {
    if (simulationTimer.current) clearInterval(simulationTimer.current);
    const currentRouteData = routeDataRef.current;
    if (!currentRouteData) return;

    const coords = currentRouteData.geometry.coordinates; 
    const baseIntervalMs = 250; 
    const stepAdvance = Math.max(1, Math.round(speedMultiplier / 2));

    simulationTimer.current = setInterval(() => {
      const currentIdx = simIndexRef.current;
      if (currentIdx >= coords.length - 1) {
        setNavState(prev => ({ 
          ...prev, 
          currentInstruction: "You have arrived at your destination!",
          remainingDistance: 0,
          remainingTime: 0
        }));
        clearInterval(simulationTimer.current);
        setTimeout(() => stopNavigation(), 3500);
        return;
      }

      const nextIdx = Math.min(currentIdx + stepAdvance, coords.length - 1);
      simIndexRef.current = nextIdx;
      
      const [lng, lat] = coords[nextIdx];
      processNavigationUpdate(lat, lng, stepAdvance);
    }, baseIntervalMs);
  };

  const startNavigation = async (simulate = false) => {
    const currentRouteData = routeDataRef.current;
    if (!currentRouteData) return;
    
    setRouteError(''); 
    setGpsWarning(''); 
    setLocationWarning('');

    // Pre-flight check: Verify user's actual location is near the route
    if (!simulate) {
      if (!('geolocation' in navigator)) {
        setGpsWarning("Geolocation API is unsupported by your browser window environment.");
        return;
      }

      try {
        const position = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, { 
            enableHighAccuracy: false, 
            maximumAge: 15000, 
            timeout: 10000 
          });
        });

        const { latitude, longitude } = position.coords;
        const coords = currentRouteData.geometry.coordinates;
        let minDistance = Infinity;

        // Sample coordinates along the route to find the closest point
        // Stepping to save CPU while maintaining accuracy
        const stepSize = Math.max(1, Math.floor(coords.length / 50));
        for (let i = 0; i < coords.length; i += stepSize) {
          const dist = getDistance(latitude, longitude, coords[i][1], coords[i][0]);
          if (dist < minDistance) minDistance = dist;
        }

        // If user is more than 10km (~6.2 miles) away from the closest point on the route
        if (minDistance > 10000) {
          setLocationWarning("Your physical location is too far from this route. To get accurate directions, please search for a route that starts from your current location, or move closer to the starting point.");
          return; // Abort navigation initialization
        }
      } catch (error) {
         console.warn("GPS Permission Restricted:", error.code);
         setGpsWarning("Browser geolocation is blocked or unavailable. Switch to 'Simulate' mode to test running the path instantly!");
         return; // Abort navigation initialization
      }
    }

    setNavState({
      isActive: true,
      isSimulating: simulate,
      currentStepIndex: 0,
      remainingDistance: currentRouteData.distance,
      remainingTime: currentRouteData.duration,
      eta: calculateETA(currentRouteData.duration),
      currentInstruction: currentRouteData.steps[0]?.maneuver.instruction || 'Head towards destination',
      simSpeed: 10 
    });

    if (simulate) {
      simIndexRef.current = 0;
      startSimulationLoop(10); 
    } else {
      // Real-time GPS Engine tracking
      watchIdRef.current = navigator.geolocation.watchPosition(
        (position) => {
            const { latitude, longitude, speed } = position.coords;
            const currentSpeed = speed || (travelModeRef.current === 'driving' ? 15 : 1.5);
            processNavigationUpdate(latitude, longitude, currentSpeed);
        },
        (error) => {
            console.warn("GPS Tracking Lost:", error.code);
            setGpsWarning("Lost GPS connection or tracking blocked. Switch to 'Simulate' mode to test the path.");
            stopNavigation();
        },
        { enableHighAccuracy: false, maximumAge: 15000, timeout: 15000 }
      );
    }
  };

  const changeSimulationSpeed = (newSpeed) => {
    setNavState(prev => ({ ...prev, simSpeed: newSpeed }));
    if (navStateRef.current.isActive && navStateRef.current.isSimulating) {
      startSimulationLoop(newSpeed);
    }
  };

  const stopNavigation = () => {
    if (simulationTimer.current) {
      clearInterval(simulationTimer.current);
      simulationTimer.current = null;
    }
    if (watchIdRef.current) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    
    if (markersRef.current.user) {
      markersRef.current.user.remove();
      markersRef.current.user = null;
    }

    setNavState(prev => ({ ...prev, isActive: false, isSimulating: false }));
    
    if (mapInstance.current && polylineRef.current) {
      mapInstance.current.fitBounds(polylineRef.current.getBounds(), { padding: [50, 50], animate: true });
    }
  };

  return (
    <div className="flex flex-col md:flex-row h-screen w-full bg-slate-50 dark:bg-slate-900 text-slate-800 dark:text-slate-200 font-sans overflow-hidden transition-colors duration-300 relative">
      
      {/* GLOBAL CSS FOR LEAFLET OVERRIDES & NAV MARKER */}
      <style dangerouslySetInnerHTML={{__html: `
        .leaflet-container { font-family: inherit; z-index: 10; }
        .dark .map-tiles { filter: invert(100%) hue-rotate(180deg) brightness(95%) contrast(90%); }
        .leaflet-control-zoom a { color: #1e293b !important; background: #fff !important; border-color: #cbd5e1 !important; }
        .dark .leaflet-control-zoom a { color: #e2e8f0 !important; background: #1e293b !important; border-color: #334155 !important; }
        .navigation-user-marker { transition: transform 0.25s linear; }
      `}} />

      {/* LOCATION WARNING POPUP MODAL */}
      {locationWarning && (
        <div className="absolute inset-0 z-[100] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-slate-800 rounded-3xl shadow-2xl max-w-md w-full p-8 text-center animate-in zoom-in-95 duration-200 border border-slate-100 dark:border-slate-700">
            <div className="w-20 h-20 bg-red-100 dark:bg-red-900/30 text-red-500 rounded-full flex items-center justify-center mx-auto mb-6">
              <MapPin className="w-10 h-10" />
            </div>
            <h2 className="text-2xl font-black text-slate-900 dark:text-white mb-3 tracking-tight">Too Far From Route</h2>
            <p className="text-slate-600 dark:text-slate-300 mb-8 leading-relaxed">
              {locationWarning}
            </p>
            <button
              onClick={() => setLocationWarning('')}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3.5 px-4 rounded-xl transition-colors shadow-lg shadow-blue-500/30"
            >
              Okay, got it
            </button>
          </div>
        </div>
      )}

      {/* NAVIGATION OVERLAY (Only visible when navigating) */}
      {navState.isActive && (
        <div className="absolute inset-0 z-50 flex flex-col pointer-events-none">
          {/* Top Big Turn Instruction */}
          <div className="bg-green-600 dark:bg-green-700 text-white p-5 md:p-6 shadow-2xl pointer-events-auto rounded-b-3xl transform transition-transform duration-500">
            <div className="max-w-4xl mx-auto flex items-center gap-6">
               <div className="bg-green-800/50 p-3.5 rounded-2xl">
                  <Compass className="w-10 h-10 md:w-12 md:h-12 animate-pulse" />
               </div>
               <div className="flex-1">
                  <h2 className="text-xs md:text-sm font-bold text-green-200 uppercase tracking-widest mb-1">Upcoming</h2>
                  <p className="text-2xl md:text-4xl font-extrabold tracking-tight leading-tight">
                    {navState.currentInstruction || "Proceed to route"}
                  </p>
               </div>
            </div>
          </div>

          <div className="flex-1"></div> {/* Spacer */}

          {/* SIMULATION SPEED CONTROL BOX */}
          {navState.isSimulating && (
            <div className="self-center mb-4 pointer-events-auto bg-slate-950/90 text-white px-5 py-3.5 rounded-2xl shadow-xl flex items-center gap-4 border border-slate-800 animate-bounce">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
                <FastForward className="w-4 h-4 text-blue-400" /> Speed:
              </span>
              <div className="flex gap-2">
                {[1, 5, 10, 25, 50].map((speed) => (
                  <button
                    key={speed}
                    onClick={() => changeSimulationSpeed(speed)}
                    className={`px-3 py-1 text-xs font-bold rounded-lg transition-all ${
                      navState.simSpeed === speed
                        ? 'bg-blue-500 text-white ring-2 ring-blue-400'
                        : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
                    }`}
                  >
                    {speed}x
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Bottom Stats Bar */}
          <div className="bg-white dark:bg-slate-800 shadow-[0_-10px_40px_rgba(0,0,0,0.1)] p-4 md:p-6 pointer-events-auto border-t border-slate-200 dark:border-slate-700">
            <div className="max-w-4xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-4">
              <div className="flex items-end gap-4 md:gap-8 text-center sm:text-left w-full sm:w-auto justify-center">
                 <div>
                    <p className="text-3xl md:text-5xl font-black text-green-600 dark:text-green-500 tracking-tight">
                      {formatDuration(navState.remainingTime).split(' ')[0]}
                      <span className="text-lg md:text-2xl text-slate-500 dark:text-slate-400 font-medium ml-1">
                        {formatDuration(navState.remainingTime).split(' ').slice(1).join(' ')}
                      </span>
                    </p>
                 </div>
                 <div className="pb-1">
                    <p className="text-lg md:text-2xl font-bold text-slate-700 dark:text-slate-200">
                      {formatDistance(navState.remainingDistance, true)}
                    </p>
                 </div>
                 <div className="pb-2 hidden md:block">
                    <p className="text-base font-medium text-slate-500 dark:text-slate-400">
                      ETA <span className="text-slate-800 dark:text-white font-bold">{navState.eta}</span>
                    </p>
                 </div>
              </div>

              <button 
                onClick={stopNavigation}
                className="w-full sm:w-auto bg-red-500 hover:bg-red-600 text-white px-8 py-3.5 rounded-xl font-bold text-lg shadow-lg hover:shadow-red-500/30 transition-all flex items-center justify-center gap-2"
              >
                <X className="w-5 h-5" /> Exit
              </button>
            </div>
          </div>
        </div>
      )}


      {/* SIDEBAR */}
      <div className={`w-full md:w-[400px] h-[50vh] md:h-screen flex flex-col bg-white dark:bg-slate-900 shadow-2xl z-20 transition-all duration-500 ${navState.isActive ? '-translate-x-full absolute opacity-0' : 'relative'}`}>
        
        {/* Header & Controls */}
        <div className="p-4 md:p-6 border-b border-slate-200 dark:border-slate-800 shrink-0">
          <div className="flex justify-between items-center mb-6">
            <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400">
              <Navigation className="w-6 h-6" />
              <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">Route Navigator</h1>
            </div>
            <button 
              onClick={() => setDarkMode(!darkMode)}
              className="p-2 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              {darkMode ? <Sun className="w-5 h-5 text-amber-400" /> : <Moon className="w-5 h-5 text-slate-600" />}
            </button>
          </div>

          {/* Inputs */}
          <div className="relative space-y-3">
            <div className="flex items-center gap-3">
              <div className="w-5 flex justify-center text-blue-500"><MapPin className="w-5 h-5" /></div>
              <div className="flex-1 relative">
                <input
                  type="text" placeholder="Choose starting point, or click map"
                  value={activeInput === 'start' ? searchQuery : (startPoint?.label || '')}
                  onChange={(e) => { setActiveInput('start'); setSearchQuery(e.target.value); }}
                  onFocus={() => { setActiveInput('start'); setSearchQuery(startPoint?.label || ''); }}
                  className="w-full bg-slate-100 dark:bg-slate-800 border-none rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                />
                {startPoint && activeInput !== 'start' && (
                  <button onClick={() => setStartPoint(null)} className="absolute right-3 top-3.5 text-slate-400 hover:text-slate-600">
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>

            <div className="absolute left-2.5 top-[45px] bottom-[45px] w-px bg-slate-300 dark:bg-slate-700"></div>

            <button 
              onClick={swapLocations}
              className="absolute right-[-10px] top-[40px] z-10 p-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-full shadow-sm hover:shadow-md transition-all text-slate-500"
            >
              <ArrowRightLeft className="w-4 h-4 rotate-90" />
            </button>

            <div className="flex items-center gap-3">
              <div className="w-5 flex justify-center text-red-500"><MapPin className="w-5 h-5 fill-current" /></div>
              <div className="flex-1 relative">
                <input
                  type="text" placeholder="Choose destination, or click map"
                  value={activeInput === 'end' ? searchQuery : (endPoint?.label || '')}
                  onChange={(e) => { setActiveInput('end'); setSearchQuery(e.target.value); }}
                  onFocus={() => { setActiveInput('end'); setSearchQuery(endPoint?.label || ''); }}
                  className="w-full bg-slate-100 dark:bg-slate-800 border-none rounded-lg px-4 py-3 text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                />
                {endPoint && activeInput !== 'end' && (
                  <button onClick={() => setEndPoint(null)} className="absolute right-3 top-3.5 text-slate-400 hover:text-slate-600">
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Autocomplete Dropdown */}
          {activeInput && searchResults.length > 0 && (
            <div className="absolute left-0 right-0 mx-6 mt-2 bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-100 dark:border-slate-700 z-50 overflow-hidden max-h-60 overflow-y-auto">
              {searchResults.map((result) => (
                <button
                  key={result.place_id}
                  onClick={() => handleSelectSearchResult(result)}
                  className="w-full text-left px-4 py-3 border-b border-slate-100 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors flex items-start gap-3"
                >
                  <Search className="w-4 h-4 mt-1 text-slate-400 shrink-0" />
                  <span className="text-sm line-clamp-2">{result.display_name}</span>
                </button>
              ))}
            </div>
          )}

          {/* Transport Modes */}
          <div className="flex bg-slate-100 dark:bg-slate-800 p-1 rounded-lg mt-6">
            {[
              { id: 'driving', icon: Car, label: 'Drive' },
              { id: 'walking', icon: Footprints, label: 'Walk' },
              { id: 'cycling', icon: Bike, label: 'Cycle' }
            ].map(({ id, icon: Icon, label }) => (
              <button
                key={id}
                onClick={() => setTravelMode(id)}
                className={`flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-all ${
                  travelMode === id 
                    ? 'bg-white dark:bg-slate-700 shadow-sm text-blue-600 dark:text-blue-400' 
                    : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span className="hidden sm:inline">{label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Dynamic Content Area */}
        <div className="flex-1 overflow-y-auto bg-slate-50/50 dark:bg-slate-900/50 relative">
          
          {loadingRoute && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/80 dark:bg-slate-900/80 z-10 backdrop-blur-sm">
              <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
              <p className="text-sm font-medium animate-pulse">Calculating optimal route...</p>
            </div>
          )}

          {gpsWarning && (
            <div className="m-4 p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 rounded-xl flex items-start gap-3 animate-in fade-in">
              <AlertCircle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-semibold text-amber-800 dark:text-amber-400">Sandbox Preview Geolocation Blocked</p>
                <p className="text-xs text-amber-600 dark:text-amber-500 mt-1">{gpsWarning}</p>
                <button
                  onClick={() => {
                    setGpsWarning('');
                    startNavigation(true);
                  }}
                  className="mt-2.5 bg-amber-600 hover:bg-amber-700 text-white text-xs px-3 py-1.5 rounded-lg font-bold transition-all shadow-md"
                >
                  Launch Route Simulation Now
                </button>
              </div>
            </div>
          )}

          {routeError && (
            <div className="p-6 text-center animate-in fade-in">
              <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-3" />
              <p className="text-red-500 font-medium">{routeError}</p>
            </div>
          )}

          {routeData && !loadingRoute && (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
              {/* Route Summary & Start Navigation Buttons */}
              <div className="bg-blue-600 text-white p-6 sticky top-0 z-10 shadow-md">
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <div className="text-3xl font-bold tracking-tight mb-1">
                      {formatDuration(routeData.duration)}
                    </div>
                    <div className="text-blue-100 font-medium flex items-center gap-2 mb-1">
                      <Route className="w-4 h-4" />
                      {formatDistance(routeData.distance, true)} ({formatDistance(routeData.distance, false)})
                    </div>
                    <div className="text-blue-200 text-sm">
                      ETA {calculateETA(routeData.duration)}
                    </div>
                  </div>
                  <button onClick={clearRoute} className="text-xs bg-white/20 hover:bg-white/30 px-3 py-1.5 rounded-full font-medium transition-colors">
                    Clear
                  </button>
                </div>

                <div className="flex gap-2 mt-4">
                  <button 
                    onClick={() => startNavigation(false)}
                    className="flex-1 bg-white text-blue-600 hover:bg-slate-100 py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-colors shadow-sm"
                  >
                    <Navigation className="w-5 h-5 fill-current" /> Start GPS
                  </button>
                  <button 
                    onClick={() => startNavigation(true)}
                    className="flex-1 bg-blue-700 text-white hover:bg-blue-800 border border-blue-500 py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-colors shadow-sm"
                    title="Simulates driving the route for testing"
                  >
                    <Play className="w-5 h-5" /> Simulate
                  </button>
                </div>
              </div>

              {/* Turn by Turn Directions */}
              <div className="p-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-4 ml-2">Turn-by-Turn Directions</h3>
                <div className="space-y-1">
                  {routeData.steps.map((step, idx) => {
                    const isLast = idx === routeData.steps.length - 1;
                    return (
                      <div 
                        key={idx} 
                        className="group flex gap-4 p-3 hover:bg-white dark:hover:bg-slate-800 rounded-xl transition-all cursor-pointer hover:shadow-sm"
                        onClick={() => zoomToStep(step.maneuver.location)}
                      >
                        <div className="flex flex-col items-center shrink-0">
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center ${isLast ? 'bg-green-100 text-green-600' : 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300'} group-hover:scale-110 transition-transform`}>
                            {isLast ? <CheckCircle className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                          </div>
                          {!isLast && <div className="w-0.5 h-full bg-slate-200 dark:bg-slate-700 mt-2 group-hover:bg-blue-200 dark:group-hover:bg-blue-800 transition-colors"></div>}
                        </div>
                        <div className="pb-4 pt-1 flex-1">
                          <p className="text-sm font-medium leading-relaxed">
                            {step.maneuver.instruction || `Continue on ${step.name || 'route'}`}
                          </p>
                          {step.distance > 0 && (
                            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                              {formatDistance(step.distance, true)}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {!routeData && !loadingRoute && !routeError && startPoint && !endPoint && (
            <div className="h-full flex flex-col items-center justify-center text-slate-400 p-8 text-center animate-in fade-in">
              <MapPin className="w-12 h-12 text-red-300 dark:text-red-800 mb-4" />
              <p className="text-lg font-medium text-slate-600 dark:text-slate-300">Start point set</p>
              <p className="text-sm mt-2">Search for a destination or click anywhere on the map.</p>
            </div>
          )}

          {!routeData && !loadingRoute && !routeError && !startPoint && (
             <div className="h-full flex flex-col items-center justify-center p-8 opacity-20 pointer-events-none">
               <MapIcon className="w-32 h-32" />
             </div>
          )}
        </div>
      </div>

      {/* MAP CONTAINER */}
      <div className="flex-1 relative bg-slate-200 dark:bg-slate-800 h-[50vh] md:h-screen">
        <div id="map" ref={mapRef} className="w-full h-full absolute inset-0 z-0"></div>
        
        {/* Loading State */}
        {!isMapLoaded && !mapLoadError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-100 dark:bg-slate-900 z-10">
            <div className="animate-spin text-blue-500 mb-4"><Navigation className="w-8 h-8" /></div>
            <p className="text-slate-500 font-medium">Initializing Map Engine...</p>
          </div>
        )}

        {/* Error State if scripts get blocked */}
        {mapLoadError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-100 dark:bg-slate-900 z-10 text-red-500 p-8 text-center">
            <AlertCircle className="w-12 h-12 mb-4" />
            <p className="font-bold">{mapLoadError}</p>
            <p className="text-sm text-slate-500 mt-2">Try refreshing the page or checking your browser's tracking protection/ad-blocker settings.</p>
          </div>
        )}
      </div>

    </div>
  );
}
