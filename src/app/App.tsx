import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DiagnosticsPanel } from '../components/DiagnosticsPanel';
import { FilesPanel } from '../components/FilesPanel';
import { RecordingBrowser } from '../components/RecordingBrowser';
import { RouteMap } from '../components/RouteMap';
import { ARROW_PATH } from '../components/arrow';
import { Telemetry } from '../components/Telemetry';
import { clock } from '../components/Timeline';
import { Transport } from '../components/Transport';
import { VideoPanel, type PanelRole } from '../components/VideoPanel';
import { GpsTimeline } from '../gps/GpsTimeline';
import type { SpeedUnit } from '../gps/units';
import { PlaybackController } from '../media/PlaybackController';
import { filesFromDrop, mergeFiles, wanted } from './files';
import { VERSION, VERSION_LABEL } from '../version';
import { loadPrefs, savePrefs } from './prefs';
import type { PairResult } from '../recordings/RecordingPairer';
import { GpsStore } from '../gps/GpsStore';
import type { GpxPoint } from '../gps/GpxParser';
import { addWindowGps, describeFiles, embeddedGpsFor, loadTrip, previewGps, type Loaded } from './loadTrip';
import { fmt } from './usePlayback';

type View = 'pip' | 'front' | 'rear' | 'map';
type Tab = 'clips' | 'files' | 'diagnostics';
const EMPTY_GPS = new GpsTimeline([], 'knots');
const VIEWS: Array<[View, string]> = [
  ['pip', 'Picture in picture'],
  ['front', 'Front'],
  ['rear', 'Rear'],
  ['map', 'Map only'],
];

export function App() {
  const ctrl = useMemo(() => new PlaybackController(), []);
  useEffect(() => () => ctrl.dispose(), [ctrl]);

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  // (a remembered "side by side" from an older version falls back to picture-in-picture)
  const [view, setView] = useState<View>(() => (['pip', 'front', 'rear'] as const).find((v) => v === loadPrefs().view) ?? 'pip');
  const [pipSwap, setPipSwap] = useState(false);
  const [gpsOn, setGpsOn] = useState(() => {
    const q = new URLSearchParams(location.search).get('gps');
    return q !== null ? q !== '0' : loadPrefs().gpsOn ?? true;
  });
  const [gpsOffset, setGpsOffset] = useState(0);
  const [infoPanel, setInfoPanel] = useState(() => loadPrefs().panel ?? true);
  const [unit, setUnit] = useState<SpeedUnit>(() => loadPrefs().unit ?? 'knots');
  const [tab, setTab] = useState<Tab>('clips');
  const [dragging, setDragging] = useState(false);
  const [scanning, setScanning] = useState<string | null>(null); // feedback while the browser lists a picked/dropped folder
  const pickPending = useRef(false);
  const [fileCount, setFileCount] = useState(0);
  const [gps, setGps] = useState<GpsTimeline>(EMPTY_GPS);

  const filesRef = useRef<File[]>([]);
  const loadedRef = useRef<Loaded | null>(null);
  const tripWide = useRef<string | undefined>(undefined);
  const unitRef = useRef<SpeedUnit>(loadPrefs().unit ?? 'knots');
  const gpsOnRef = useRef(gpsOn);
  const gen = useRef(0);
  const startedRef = useRef(false);
  // loading page: only GPS is read (nothing else is opened) and drawn on a map; raw points are kept for the session
  const gpsCache = useRef(new Map<string, GpxPoint[]>());
  const stageTried = useRef(new Set<string>());
  const [stageStore, setStageStore] = useState(() => new GpsStore('knots'));
  const [stagedGps, setStagedGps] = useState<GpsTimeline>(EMPTY_GPS);
  const [preview, setPreview] = useState(false); // GPS-only route preview on the loading page: off unless chosen
  const [stageRead, setStageRead] = useState<{ done: number; total: number } | null>(null);
  const [staged, setStaged] = useState<PairResult | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);
  gpsOnRef.current = gpsOn;
  unitRef.current = unit;

  /** (Re)build the trip from every file added so far; keeps the playing position when the clip is still there. */
  const rebuild = useCallback(
    async (all: File[], autoplay = false) => {
      const pair = describeFiles(all);
      if (!pair.entries.length) return setNotice('No front/rear recordings (.TS or .mp4) found in that selection.');
      setNotice(undefined);
      const my = ++gen.current;
      const prev = loadedRef.current;
      const snap = ctrl.snapshot();
      const resume = prev && snap.total > 0 ? { key: prev.trip.segments[snap.segIndex]?.key, local: snap.segLocal, play: snap.wantPlay } : undefined;
      tripWide.current = pair.looseGpx.length === 1 && !pair.entries.some((e) => e.gpx) ? pair.looseGpx[0]!.name : undefined;
      setBusy(true);
      let first = true;
      // the first clip gets the disk to itself; probing the other clips starts once it is ready (or after 20 s)
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const fallback = setTimeout(release, 20000);
      try {
        await loadTrip(pair, { speedUnit: unitRef.current, tripWideName: tripWide.current, excluded: new Set(), cancelled: () => gen.current !== my, gate }, (l, complete) => {
          if (gen.current !== my) return;
          loadedRef.current = l;
          setLoaded(l);
          if (!first) return ctrl.updateTrip(l.trip, complete);
          first = false;
          void ctrl.load(l.trip, complete).then(() => {
            release();
            if (autoplay && !resume) return void ctrl.play(); // Start session: begin playing
            const g = resume?.key ? l.trip.segments.find((x) => x.key === resume.key) : undefined;
            if (!g) return;
            ctrl.seek(g.globalStart + resume!.local);
            if (resume!.play) void ctrl.play();
          });
        });
      } finally {
        clearTimeout(fallback);
        release();
        if (gen.current === my) setBusy(false);
      }
    },
    [ctrl],
  );

  const addFiles = useCallback(
    (f: File[]) => {
      const usable = f.filter(wanted);
      if (!usable.length) return setNotice('Nothing the player can use there: it looks for .TS or .mp4 recordings and .gpx files.');
      filesRef.current = mergeFiles(filesRef.current, usable);
      setFileCount(filesRef.current.length);
      // before the session starts files only pile up (names are paired, nothing is read); after, they join the running trip
      if (startedRef.current) void rebuild(filesRef.current);
      else setStaged(describeFiles(filesRef.current));
    },
    [rebuild],
  );

  const startSession = useCallback(() => {
    if (!filesRef.current.length) return;
    startedRef.current = true;
    setStaged(null);
    void rebuild(filesRef.current, true);
  }, [rebuild]);

  const clear = () => {
    gen.current++;
    filesRef.current = [];
    loadedRef.current = null;
    startedRef.current = false;
    setStaged(null);
    setView('pip'); // the loading page has no view menu: never start a new session in a view chosen for the last one
    setStageStore(new GpsStore('knots'));
    setStagedGps(EMPTY_GPS);
    setStageRead(null);
    setPreview(false);
    stageTried.current.clear();
    gpsCache.current.clear();
    setFileCount(0);
    setLoaded(null);
    setBusy(false);
    ctrl.pause();
  };

  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    pickPending.current = false;
    setScanning(null);
    addFiles(Array.from(e.target.files ?? []));
    e.target.value = '';
  };
  const cancelPick = () => {
    pickPending.current = false;
    setScanning(null);
  };
  useEffect(() => {
    const ins = [fileInput.current, dirInput.current];
    const off = () => {
      pickPending.current = false;
      setScanning(null);
    };
    ins.forEach((i) => i?.addEventListener('cancel', off));
    return () => ins.forEach((i) => i?.removeEventListener('cancel', off));
  }, []);
  /** Open a file/folder dialog. The browser lists a big folder before it tells us anything, so show that as soon as the dialog closes. */
  const openPicker = (input: HTMLInputElement | null) => {
    if (!input) return;
    pickPending.current = true;
    const onFocus = () => {
      window.removeEventListener('focus', onFocus);
      setTimeout(() => pickPending.current && setScanning('Reading files…'), 200);
      setTimeout(() => pickPending.current && cancelPick(), 30000); // dialog cancelled in a browser without the cancel event
    };
    window.addEventListener('focus', onFocus);
    input.click();
  };

  // drag files or folders anywhere on the page
  useEffect(() => {
    let depth = 0;
    const has = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => has(e) && (e.preventDefault(), depth++, setDragging(true));
    const over = (e: DragEvent) => has(e) && e.preventDefault();
    const leave = (e: DragEvent) => has(e) && --depth <= 0 && ((depth = 0), setDragging(false));
    const drop = (e: DragEvent) => {
      if (!has(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      setScanning('Reading folder…');
      void filesFromDrop(e.dataTransfer!, (n) => setScanning(`Reading folder… ${n} clips found`))
        .then(addFiles)
        .finally(() => setScanning(null));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [addFiles]);

  // remembered options: restore sound/speed once, save changes (this browser only)
  useEffect(() => {
    const p = loadPrefs();
    if (p.rate) ctrl.setRate(p.rate);
    if (p.audio) ctrl.setAudio(p.audio);
    if (p.volume !== undefined) ctrl.setVolume(p.volume);
    if (p.overlap === false) ctrl.overlap = false;
    let last = '';
    return ctrl.subscribe((s) => {
      const k = `${s.rate}|${s.audio}|${s.volume}`;
      if (k !== last) {
        if (last) savePrefs({ rate: s.rate, audio: s.audio, volume: s.volume });
        last = k;
      }
    });
  }, [ctrl]);
  useEffect(() => savePrefs({ gpsOn, unit, panel: infoPanel }), [gpsOn, unit, infoPanel]);
  useEffect(() => {
    if (view !== 'map') savePrefs({ view });
  }, [view]);

  // the Settings menu closes on a click elsewhere or Escape
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: Event) => {
      const d = menu.current;
      if (!d?.open) return;
      if (e.type === 'keydown' ? (e as KeyboardEvent).key === 'Escape' : !d.contains(e.target as Node)) d.open = false;
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', close);
    };
  }, []);

  // GPS is append-only: each clip's track is read when the clip is prepared and kept for the map.
  useEffect(() => {
    ctrl.onPrepare = (seg, clip) => {
      const l = loadedRef.current;
      if (!l || !gpsOnRef.current) return;
      const tw = !!tripWide.current;
      const whole = gpsCache.current.get(seg.key); // read earlier by the route preview
      if (whole) void embeddedGpsFor(l.gps, seg, unitRef.current, tw, whole);
      else if (clip.gps) addWindowGps(l.gps, seg, unitRef.current, tw, clip.gps); // this window's part, merged into the clip's track
      else void embeddedGpsFor(l.gps, seg, unitRef.current, tw);
    };
    return () => void (ctrl.onPrepare = undefined);
  }, [ctrl]);
  useEffect(() => {
    if (!loaded) return setGps(EMPTY_GPS);
    setGps(loaded.gps.timeline);
    return loaded.gps.subscribe(setGps);
  }, [loaded?.gps]);

  // the unit changes how GPS speed is read: rebuild so already-read tracks use it
  const firstUnit = useRef(true);
  useEffect(() => {
    if (firstUnit.current) return void (firstUnit.current = false);
    if (filesRef.current.length) void rebuild(filesRef.current);
  }, [unit, rebuild]);

  useEffect(() => {
    setStagedGps(stageStore.timeline);
    return stageStore.subscribe(setStagedGps);
  }, [stageStore]);
  useEffect(() => {
    if (!staged || !preview || startedRef.current || !gpsOn) return;
    const todo = staged.entries.filter((e) => !stageTried.current.has(e.key));
    if (!todo.length) return;
    todo.forEach((e) => stageTried.current.add(e.key));
    const total = stageTried.current.size;
    let done = total - todo.length;
    setStageRead({ done, total });
    let i = 0;
    const worker = async () => {
      while (i < todo.length && !startedRef.current) {
        await previewGps(stageStore, todo[i++]!, unitRef.current, gpsCache.current).catch(() => undefined);
        setStageRead({ done: ++done, total });
      }
    };
    void Promise.all([worker(), worker()]).then(() => setStageRead((r) => (r && r.done >= r.total ? null : r)));
  }, [staged, preview, gpsOn, stageStore]);

  // Map only: nothing from the audio/video files is opened; the clock runs on its own
  const mapOnly = view === 'map';
  useEffect(() => void ctrl.setMedialess(mapOnly), [ctrl, mapOnly]);

  // ...so every clip's GPS is read up front (two at a time); the route grows as each one arrives
  const tried = useRef(new Set<string>());
  const [reading, setReading] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => void tried.current.clear(), [loaded?.gps]);
  const nSegs = loaded?.trip.segments.length ?? 0;
  useEffect(() => {
    const l = loadedRef.current;
    if (!mapOnly || !l || !gpsOn) return setReading(null);
    const todo = l.trip.segments.filter((x) => !tried.current.has(x.key));
    if (!todo.length) return;
    todo.forEach((x) => tried.current.add(x.key));
    let done = tried.current.size - todo.length;
    const total = tried.current.size;
    setReading({ done, total });
    let i = 0;
    const worker = async () => {
      while (i < todo.length) {
        const seg = todo[i++]!;
        await embeddedGpsFor(l.gps, seg, unitRef.current, !!tripWide.current, gpsCache.current.get(seg.key));
        setReading({ done: ++done, total: Math.max(total, loadedRef.current?.trip.segments.length ?? total) });
      }
    };
    void Promise.all([worker(), worker()]).then(() => setReading((r) => (r && r.done >= r.total ? null : r)));
  }, [mapOnly, gpsOn, nSegs, loaded?.gps]);

  const gpsCovered = useCallback(
    (i: number) => {
      const g = loaded?.trip.segments[i];
      if (!g || !gps.length) return false;
      return gps.at(g.globalStart + 0.5 - gpsOffset).state === 'ok' || gps.at(g.globalEnd - 0.5 - gpsOffset).state === 'ok';
    },
    [loaded, gps, gpsOffset],
  );

  const roles: Record<'front' | 'rear', PanelRole> =
    view === 'map' ? { front: 'hidden', rear: 'hidden' } : view === 'pip' ? (pipSwap ? { front: 'mini', rear: 'main' } : { front: 'main', rear: 'mini' }) : view === 'front' ? { front: 'main', rear: 'hidden' } : { front: 'hidden', rear: 'main' };

  const showHero = !loaded && !(staged && preview && !busy);
  const segs = loaded?.trip.segments ?? [];
  const summary = segs.length
    ? `${new Date(segs[0]!.entry.startMs).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })} · ${clock(segs[0]!.entry.startMs).slice(0, 5)}–${clock(segs[segs.length - 1]!.entry.startMs + segs[segs.length - 1]!.duration * 1000).slice(0, 5)} · ${segs.length} clips · ${fmt(loaded!.trip.totalDuration)}${busy ? ' · reading…' : ''}`
    : '';

  return (
    <div className={`app ${loaded ? '' : 'landing'}`}>
      <input ref={fileInput} type="file" hidden multiple accept=".ts,.mp4,.gpx" onChange={pick} />
      <input ref={dirInput} type="file" hidden multiple onChange={pick} {...({ webkitdirectory: '' } as object)} />

      {loaded && (
      <header className="top">
        <div className="brand">
          <span className="logo" aria-hidden="true">◉</span>
          <div>
            <h1>
              Dashcam Player <small className="ver" title="Version of this player">v{VERSION}</small>
            </h1>
            {summary && <p className="trip-sum">{summary}</p>}
          </div>
        </div>
        {loaded && (
        <div className="top-actions">
          <div className="seg-control" role="group" aria-label="View">
            {VIEWS.map(([v, name]) => (
              <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
                {name}
              </button>
            ))}
          </div>
          <button onClick={() => openPicker(fileInput.current)} title="Add recordings or a GPX file. Adds to what is already loaded.">＋ Add files</button>
          <button onClick={() => openPicker(dirInput.current)} title="Add a whole folder (for example the SD card or remuxed/)">＋ Add folder</button>
          <details className="menu" ref={menu}>
            <summary aria-label="Settings">⚙ Settings</summary>
            <div className="menu-pop">
              <h3>Picture</h3>
              <label className="row" title="Show speed and position on the picture, the map and the compass. Off = nothing is read for GPS.">
                <span>Show GPS</span>
                <input type="checkbox" checked={gpsOn} onChange={(e) => setGpsOn(e.target.checked)} />
              </label>
              <label className="row" title="A panel in the bottom-left corner of the picture with speed, time and date. It covers the text the camera burned into the picture. Turn it off to see the whole original picture.">
                <span>Info panel on the picture</span>
                <input type="checkbox" checked={infoPanel} onChange={(e) => setInfoPanel(e.target.checked)} />
              </label>
              <label className="row" title="Shifts GPS relative to the video. Positive = GPS later.">
                <span>GPS offset (s)</span>
                <input type="number" step={0.5} value={gpsOffset} onChange={(e) => setGpsOffset(+e.target.value || 0)} />
              </label>
              <label className="row" title="Unit of the speed stored in GPX and in the camera's GPS. The Wolfbox writes knots.">
                <span>GPS speed unit</span>
                <select value={unit} onChange={(e) => setUnit(e.target.value as SpeedUnit)}>
                  <option value="knots">knots (Wolfbox)</option>
                  <option value="mps">m/s</option>
                  <option value="kmh">km/h</option>
                  <option value="mph">mph</option>
                </select>
              </label>

              <h3>Cameras</h3>
              <label className="row" title="Rear media time = front media time + offset">
                <span>Rear camera offset (s)</span>
                <input type="number" step={0.1} defaultValue={0} onChange={(e) => ctrl.setCameraOffset(+e.target.value || 0)} />
              </label>

              <h3>Playback engine (raw .TS)</h3>
              <label className="row" title="Convert: each short window is prepared before it plays (smooth, recommended). Stream starts faster but can show seams on some browsers.">
                <span>Method</span>
                <select defaultValue="convert" onChange={(e) => void ctrl.setStream(e.target.value === 'stream')}>
                  <option value="convert">Convert (smooth)</option>
                  <option value="stream">Stream (faster start)</option>
                </select>
              </label>
              <label className="row" title="Seamless: the next 15-second part is lined up to the same frame underneath before the picture switches. Simple: it switches at the end of each part. The player drops to Simple by itself if the seamless way fails twice.">
                <span>Hand-over</span>
                <select defaultValue={loadPrefs().overlap === false ? 'simple' : 'seamless'} onChange={(e) => { ctrl.overlap = e.target.value === 'seamless'; savePrefs({ overlap: ctrl.overlap }); }}>
                  <option value="seamless">Seamless</option>
                  <option value="simple">Simple</option>
                </select>
              </label>

              <h3>Shortcuts</h3>
              <dl className="keys">
                <dt>Space</dt><dd>Play / pause</dd>
                <dt>← →</dt><dd>5 s back / forward (Shift: 30 s)</dd>
                <dt>[ ]</dt><dd>Previous / next clip</dd>
                <dt>Home End</dt><dd>Start / end of the trip</dd>
                <dt>, .</dt><dd>Slower / faster</dd>
                <dt>↑ ↓</dt><dd>Volume</dd>
                <dt>M</dt><dd>Mute</dd>
                <dt>F</dt><dd>Full screen</dd>
              </dl>
              <p className="muted ver-line">Dashcam Player {VERSION_LABEL}</p>
              <button className="ghost" onClick={() => { try { localStorage.removeItem('dashcam-player-prefs-v1'); } catch { /* nothing saved */ } location.reload(); }} title="Forget the options this browser remembers">Reset remembered options</button>
            </div>
          </details>
        </div>
        )}
      </header>
      )}

      {scanning && (staged || loaded) && (
        <p className="banner info" role="status">
          <span className="spin small" aria-hidden="true" /> {scanning}
        </p>
      )}
      {notice && (
        <p className="banner" role="alert">
          {notice} <button className="ghost" onClick={() => setNotice(undefined)}>Dismiss</button>
        </p>
      )}

      {showHero && (
        <section className={`hero ${dragging ? 'drag' : ''}`}>
          <HeroArt />
          <div className="hero-inner">
            <Brand />
            <div className={`hero-card ${staged || busy || scanning ? 'solid' : 'drop'}`}>
              {scanning && !staged ? (
                <>
                  <span className="spin big" aria-label="Reading" />
                  <h2>{scanning}</h2>
                </>
              ) : busy ? (
                <>
                  <span className="spin big" aria-label="Reading" />
                  <h2>Getting your trip ready…</h2>
                  <p className="muted small">The first clip starts as soon as it is ready</p>
                  <button className="ghost" onClick={clear}>Cancel</button>
                </>
              ) : staged ? (
                <Staged pair={staged} onStart={startSession} onPreview={() => setPreview(true)} onFiles={() => openPicker(fileInput.current)} onFolder={() => openPicker(dirInput.current)} onClear={clear} />
              ) : (
                <>
                  <h2>Drop your recordings here</h2>
                  <div className="welcome-actions">
                    <button className="primary" onClick={() => openPicker(dirInput.current)}>Choose folder…</button>
                    <button onClick={() => openPicker(fileInput.current)}>Choose files…</button>
                  </div>
                  <div className="chips" aria-label="Supported files">
                    <span>.TS</span>
                    <span>.mp4</span>
                    <span>.gpx</span>
                  </div>
                </>
              )}
            </div>
          </div>
          <p className="hero-foot">{VERSION_LABEL} · Tested only with Wolfbox G840S recordings · everything stays on your computer</p>
        </section>
      )}

      <main hidden={showHero} className={mapOnly ? 'maponly' : ''}>
        <div className="left">
          {mapOnly && loaded && (
            <div className="mapstage">
              {gpsOn ? <RouteMap ctrl={ctrl} gps={gps} gpsOffset={gpsOffset} tall /> : <p className="card muted">GPS is off. Turn it on in Settings to see the map.</p>}
              {gpsOn && (
                <div className="map-hud">
                  <Telemetry ctrl={ctrl} gps={gps} gpsOffset={gpsOffset} />
                  {reading && <span className="pill pill-warn">Reading GPS {Math.min(reading.done, reading.total)}/{reading.total}…</span>}
                </div>
              )}
            </div>
          )}
          {staged && preview && !loaded && !busy && (
            <div className="stagepage">
              <Staged compact pair={staged} onStart={startSession} onPreview={() => setPreview(false)} onFiles={() => openPicker(fileInput.current)} onFolder={() => openPicker(dirInput.current)} onClear={clear} />
              <div className="mapstage">
                {gpsOn ? <RouteMap gps={stagedGps} gpsOffset={0} tall /> : <p className="card muted">GPS is off. Turn it on in Settings to preview the route.</p>}
                {stageRead && <span className="pill pill-warn map-chip">Reading GPS {Math.min(stageRead.done, stageRead.total)}/{stageRead.total}…</span>}
              </div>
            </div>
          )}
          <div className={`stage mode-${view}`} hidden={!loaded || mapOnly}>
            <VideoPanel ctrl={ctrl} cam="front" role={roles.front} onPick={() => setPipSwap((x) => !x)} hud={loaded && infoPanel ? <Telemetry ctrl={ctrl} gps={gps} gpsOffset={gpsOffset} hud trip={loaded.trip} showGps={gpsOn} /> : undefined} />
            <VideoPanel ctrl={ctrl} cam="rear" role={roles.rear} onPick={() => setPipSwap((x) => !x)} hud={loaded && infoPanel ? <Telemetry ctrl={ctrl} gps={gps} gpsOffset={gpsOffset} hud trip={loaded.trip} showGps={gpsOn} /> : undefined} />
          </div>
          {loaded && <Transport ctrl={ctrl} trip={loaded.trip} gpsCovered={gpsCovered} mapOnly={mapOnly} />}
        </div>

        {loaded && !mapOnly && (
          <aside className="right">
            {gpsOn ? (
              <>
                <RouteMap ctrl={ctrl} gps={gps} gpsOffset={gpsOffset} />
                <Telemetry ctrl={ctrl} gps={gps} gpsOffset={gpsOffset} />
              </>
            ) : (
              <section className="card">
                <p className="muted">GPS is off: nothing is read for it and the map is not drawn. Turn it on in Settings.</p>
              </section>
            )}
            <section className="card tabs-card">
              <div className="tabs" role="tablist">
                {([['clips', `Clips (${segs.length})`], ['files', 'Files'], ['diagnostics', `Diagnostics${loaded.warnings.length ? ` (${loaded.warnings.length})` : ''}`]] as Array<[Tab, string]>).map(([t, name]) => (
                  <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
                    {name}
                  </button>
                ))}
              </div>
              {tab === 'clips' && <RecordingBrowser ctrl={ctrl} trip={loaded.trip} gpsCovered={gpsCovered} />}
              {tab === 'files' && <FilesPanel loaded={loaded} count={fileCount} onFiles={() => openPicker(fileInput.current)} onFolder={() => openPicker(dirInput.current)} onClear={clear} />}
              {tab === 'diagnostics' && <DiagnosticsPanel ctrl={ctrl} loaded={loaded} gpsOffset={gpsOffset} />}
            </section>
          </aside>
        )}
      </main>

      {dragging && (
        <div className="dropveil" aria-hidden="true">
          <div>Drop to add {loaded ? 'to this trip' : 'recordings'}</div>
        </div>
      )}
    </div>
  );
}

function Staged({ pair, compact = false, onStart, onPreview, onFiles, onFolder, onClear }: { pair: PairResult; compact?: boolean; onStart: () => void; onPreview: () => void; onFiles: () => void; onFolder: () => void; onClear: () => void }) {
  const e = pair.entries;
  const front = e.filter((x) => x.front).length;
  const rear = e.filter((x) => x.rear).length;
  const gpx = e.filter((x) => x.gpx).length + pair.looseGpx.length;
  const first = e[0];
  const last = e[e.length - 1];
  const when = first && last ? `${new Date(first.startMs).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })} · ${clock(first.startMs).slice(0, 5)}–${clock(last.startMs + 60_000).slice(0, 5)}` : '';
  const sum = (
    <div className="stage-sum">
      <b>{e.length ? `${e.length} clip${e.length === 1 ? '' : 's'} ready` : 'No recordings found yet'}</b>
      {when && <span className="muted">{when}</span>}
      <div className="chips">
        <span>{front} front</span>
        <span>{rear} rear</span>
        {gpx > 0 && <span>{gpx} GPX</span>}
      </div>
    </div>
  );
  const start = (
    <button className="primary start" disabled={!e.length} onClick={onStart}>
      Start
    </button>
  );
  const add = (
    <>
      <button onClick={onFolder}>＋ Add folder</button>
      <button onClick={onFiles}>＋ Add files</button>
      <button className="danger" onClick={onClear}>Clear</button>
    </>
  );
  if (compact)
    return (
      <div className="stagebar">
        {sum}
        <div className="stage-actions">
          {add}
          <button onClick={onPreview} title="Hide the route preview">Hide route</button>
          {start}
        </div>
      </div>
    );
  return (
    <>
      <div className="drop-icon ok" aria-hidden="true">✓</div>
      {sum}
      <div className="welcome-actions">
        {start}
        <button disabled={!e.length} onClick={onPreview} title="Read only the GPS and show the route on a map first. No video is opened.">
          Preview route (GPS only)
        </button>
      </div>
      <div className="welcome-actions">{add}</div>
    </>
  );
}

function Brand() {
  return (
    <div className="brand-hero">
      <svg className="mark" viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
        <defs>
          <linearGradient id="mk" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#47a8ff" />
            <stop offset="1" stopColor="#6b6bff" />
          </linearGradient>
        </defs>
        <rect width="64" height="64" rx="16" fill="url(#mk)" />
        <path d={ARROW_PATH} transform="translate(32 32) scale(1.2) translate(-20 -19)" fill="#fff" />
      </svg>
      <h1>
        Dashcam <span>Player</span>
      </h1>
      <p>Front, rear and route, in perfect sync.</p>
    </div>
  );
}

/** Faint drive-route line and glows behind the loading page. */
function HeroArt() {
  return (
    <svg className="hero-art" viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id="rg" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#47a8ff" stopOpacity="0" />
          <stop offset=".5" stopColor="#47a8ff" stopOpacity=".55" />
          <stop offset="1" stopColor="#8a7bff" stopOpacity=".15" />
        </linearGradient>
      </defs>
      <path className="route" d="M-60 660 C 180 560, 260 720, 470 610 S 760 380, 900 470 S 1130 300, 1280 170" fill="none" stroke="url(#rg)" strokeWidth="3" strokeLinecap="round" strokeDasharray="2 14" />
      <path d="M-60 700 C 220 620, 330 770, 540 660 S 820 440, 960 520 S 1150 380, 1280 260" fill="none" stroke="url(#rg)" strokeWidth="1.5" strokeOpacity=".5" />
      <circle cx="900" cy="470" r="6" fill="#47a8ff" opacity=".7" />
      <circle cx="900" cy="470" r="18" fill="none" stroke="#47a8ff" opacity=".25" />
    </svg>
  );
}
