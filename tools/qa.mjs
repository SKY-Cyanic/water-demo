// QA harness: drives a real Chrome over the DevTools Protocol.
//
// The embedded preview browser reports the page as hidden, which means
// requestAnimationFrame never fires there and no frame-rate figure measured in
// it would mean anything. Everything in acceptance.md that involves a number
// therefore has to come from here.
//
//   node tools/qa.mjs smoke                 load, console check, state dump
//   node tools/qa.mjs shots                 every required capture into qa/
//   node tools/qa.mjs perf [seconds]        measured FPS at 1920x1080 and 1280x720
//   node tools/qa.mjs abshafts [s] [flag] [view] [preset] [dpr]  paired A/B on one kill switch
//   node tools/qa.mjs stress                resize / preset / medium-crossing / hidden-tab
//   node tools/qa.mjs all [perfSeconds]     everything, writes qa/report.json
//
// No dependencies: Node 22 ships a global WebSocket, and CDP is just JSON.

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = process.env.QA_ORIGIN || 'http://localhost:8173';
const ROOT = new URL( '..', import.meta.url ).pathname;
const PROFILE = '/tmp/water-demo-qa-profile';
const PORT = 9333;

/* ------------------------------------------------------------------ chrome */

class Chrome {

	constructor() {

		this.id = 0;
		this.pending = new Map();
		this.events = [];
		this.consoleErrors = [];
		this.pageErrors = [];

	}

	async launch( { width = 1920, height = 1080, headless = true } = {} ) {

		rmSync( PROFILE, { recursive: true, force: true } );

		const args = [
			`--remote-debugging-port=${PORT}`,
			`--user-data-dir=${PROFILE}`,
			`--window-size=${width},${height}`,
			'--enable-unsafe-webgpu',
			'--use-angle=metal',
			'--no-first-run',
			'--no-default-browser-check',
			'--disable-background-timer-throttling',
			'--disable-backgrounding-occluded-windows',
			'--disable-renderer-backgrounding',
			'--hide-scrollbars',
			'--mute-audio',
			'about:blank',
		];

		if ( headless ) args.unshift( '--headless=new' );

		this.proc = spawn( CHROME, args, { stdio: [ 'ignore', 'ignore', 'pipe' ] } );
		this.stderr = '';
		this.proc.stderr.on( 'data', ( c ) => { this.stderr += c; } );

		const target = await this._waitForTarget();
		await this._connect( target.webSocketDebuggerUrl );

		await this.send( 'Page.enable' );
		await this.send( 'Runtime.enable' );
		await this.send( 'Log.enable' );

		this.on( 'Runtime.consoleAPICalled', ( p ) => {

			if ( p.type === 'error' ) {

				this.consoleErrors.push( p.args.map( ( a ) => a.value ?? a.description ?? a.type ).join( ' ' ) );

			}

		} );

		this.on( 'Runtime.exceptionThrown', ( p ) => {

			this.pageErrors.push( p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'exception' );

		} );

		this.on( 'Log.entryAdded', ( p ) => {

			if ( p.entry.level === 'error' ) this.consoleErrors.push( `[${p.entry.source}] ${p.entry.text}` );

		} );

	}

	async _waitForTarget() {

		const deadline = Date.now() + 20000;

		while ( Date.now() < deadline ) {

			try {

				const list = await fetch( `http://127.0.0.1:${PORT}/json/list` ).then( ( r ) => r.json() );
				const page = list.find( ( t ) => t.type === 'page' );
				if ( page?.webSocketDebuggerUrl ) return page;

			} catch { /* not up yet */ }

			await sleep( 150 );

		}

		throw new Error( 'Chrome did not expose a debuggable page target.\n' + this.stderr.slice( - 800 ) );

	}

	_connect( url ) {

		return new Promise( ( resolve, reject ) => {

			this.ws = new WebSocket( url );
			this.ws.onopen = () => resolve();
			this.ws.onerror = ( e ) => reject( new Error( 'CDP socket error: ' + ( e.message || 'unknown' ) ) );

			this.ws.onmessage = ( ev ) => {

				const msg = JSON.parse( ev.data );

				if ( msg.id !== undefined ) {

					const p = this.pending.get( msg.id );
					if ( ! p ) return;
					this.pending.delete( msg.id );
					if ( msg.error ) p.reject( new Error( msg.error.message ) );
					else p.resolve( msg.result );

				} else {

					for ( const h of this.events ) if ( h.method === msg.method ) h.fn( msg.params );

				}

			};

		} );

	}

	on( method, fn ) {

		this.events.push( { method, fn } );

	}

	send( method, params = {} ) {

		const id = ++ this.id;
		this.ws.send( JSON.stringify( { id, method, params } ) );

		return new Promise( ( resolve, reject ) => {

			this.pending.set( id, { resolve, reject } );
			setTimeout( () => {

				if ( this.pending.has( id ) ) {

					this.pending.delete( id );
					reject( new Error( `CDP timeout: ${method}` ) );

				}

			}, 180000 );

		} );

	}

	/** Evaluate an expression in the page and return its (awaited) value. */
	async eval( expression, { awaitPromise = true } = {} ) {

		const r = await this.send( 'Runtime.evaluate', {
			expression,
			awaitPromise,
			returnByValue: true,
			userGesture: true,
		} );

		if ( r.exceptionDetails ) {

			throw new Error( 'page eval failed: ' +
				( r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ) );

		}

		return r.result.value;

	}

	async setViewport( width, height, dpr = 1 ) {

		await this.send( 'Emulation.setDeviceMetricsOverride', {
			width, height, deviceScaleFactor: dpr, mobile: false,
		} );

	}

	async goto( url ) {

		this.consoleErrors.length = 0;
		this.pageErrors.length = 0;

		await this.send( 'Page.navigate', { url } );

		// Wait for the app to finish booting rather than for a load event: the
		// renderer's shader compilation happens after DOMContentLoaded.
		const deadline = Date.now() + 90000;

		while ( Date.now() < deadline ) {

			const ready = await this.eval(
				'(() => { const a = window.__app; return !!(a && a.ocean && a.ui && typeof window.__perf === "function"); })()'
			).catch( () => false );

			if ( ready ) return;

			const fatal = await this.eval(
				'(() => { const el = document.getElementById("fatal"); return el && !el.hidden ? document.getElementById("fatal-detail").textContent.slice(0,400) : null; })()'
			).catch( () => null );

			if ( fatal ) throw new Error( 'app showed the fatal screen:\n' + fatal );

			await sleep( 250 );

		}

		throw new Error( 'app did not finish booting within 90s' );

	}

	close() {

		try { this.ws?.close(); } catch { /* ignore */ }
		try { this.proc?.kill( 'SIGTERM' ); } catch { /* ignore */ }

	}

}

const sleep = ( ms ) => new Promise( ( r ) => setTimeout( r, ms ) );

/* ------------------------------------------------------------------- steps */

/**
 * Capture through the DevTools protocol rather than the page's own
 * canvas.toDataURL().
 *
 * toDataURL reads the *presented* surface. On the WebGL 2 backend the drawing
 * buffer is cleared once the compositor has consumed it (there is no
 * preserveDrawingBuffer), so the read intermittently comes back pure black —
 * which is exactly how the fallback screenshots kept failing. CDP screenshots
 * come from the compositor itself and are correct on both backends.
 *
 * The page's own __capture() still exists for interactive use; this is the path
 * every QA artefact goes through.
 */
async function capture( chrome, name, { settle = 6 } = {} ) {

	await chrome.eval( `
		window.__qaRestore = window.__app.ui.hideForCapture();
		window.__advance(${settle});
	` );

	// Let the compositor present the settled frame.
	await sleep( 250 );

	const { data } = await chrome.send( 'Page.captureScreenshot', {
		format: 'png',
		captureBeyondViewport: false,
		fromSurface: true,
	} );

	const file = join( ROOT, 'qa', name );
	mkdirSync( join( ROOT, 'qa' ), { recursive: true } );
	writeFileSync( file, Buffer.from( data, 'base64' ) );

	await chrome.eval( 'window.__qaRestore && window.__qaRestore(); window.__qaRestore = null;' );

	return 'qa/' + name;

}

const VIEWS = {
	hero: { y: 5.5, yaw: Math.PI * 1.18, pitch: - 0.055 },
	// Framed on the moored vessel.
	vessel: { y: 4.2, yaw: Math.PI * 1.18, pitch: - 0.045 },
	// Close inspection of the vessel from every side. A hero object cannot be
	// signed off from one angle: the angle you happen to pick is the one you
	// tuned it for.
	boatSide: { x: 19.64, z: 30.46, y: 3.0, yaw: 0.5708, pitch: - 0.1120 },
	boatLow: { x: 3.98, z: 6.06, y: 1.6, yaw: - 2.5708, pitch: - 0.0308 },
	boatBow: { x: - 1.62, z: 25.10, y: 3.5, yaw: - 1.0000, pitch: - 0.1521 },
	boatStern: { x: 26.80, z: 17.55, y: 5.0, yaw: 1.5360, pitch: - 0.2359 },
	boatTop: { x: 15.86, z: 24.57, y: 9.0, yaw: 0.5708, pitch: - 0.7141 },
	// Zoomed out. The old set was entirely close-up and stationary, which is
	// exactly the condition under which distant-foam sparkle cannot appear.
	wide: { y: 42, yaw: Math.PI * 1.18, pitch: - 0.16 },
	wideHigh: { y: 120, yaw: Math.PI * 0.4, pitch: - 0.30 },
	low: { y: 2.2, yaw: Math.PI * 1.05, pitch: - 0.02 },
	// Angled down enough that the bottom is actually in frame.
	lagoon: { y: 3.4, yaw: Math.PI * 1.05, pitch: - 0.22 },
	sunward: { y: 4.0, yaw: Math.PI * 0.62, pitch: - 0.02 },
	high: { y: 8.0, yaw: Math.PI * 0.11, pitch: - 0.06 },
	// Below the surface, angled down enough to put a seabed in frame where one exists.
	under: { y: - 2.8, yaw: Math.PI, pitch: - 0.28 },
	underUp: { y: - 2.4, yaw: Math.PI, pitch: 0.62 },
	underDeep: { y: - 8.0, yaw: Math.PI * 1.1, pitch: 0.24 },
};

function setState( { preset, view = 'hero', quality } = {} ) {

	const v = VIEWS[ view ];
	const patch = {
		instant: true,
		// Hold the vessel: she makes way, and a capture set that takes a minute
		// would otherwise photograph her from a different distance every time.
		vesselHove: true,
		camera: { x: v.x ?? 0, z: v.z ?? 0, y: v.y, yaw: v.yaw, pitch: v.pitch },
	};
	if ( preset ) patch.preset = preset;
	if ( quality ) patch.quality = quality;
	return `window.__set(${JSON.stringify( patch )})`;

}

async function smoke( chrome ) {

	await chrome.goto( ORIGIN + '/' );
	await chrome.eval( 'window.__advance(3)' );

	const state = await chrome.eval( 'window.__state()' );

	return {
		state,
		consoleErrors: chrome.consoleErrors.slice(),
		pageErrors: chrome.pageErrors.slice(),
		appErrors: state.errors,
	};

}

async function shots( chrome ) {

	const out = {};

	await chrome.goto( ORIGIN + '/' );
	await sleep( 1500 );

	const presets = [
		[ 'open-sea', 'qa-open-sea.png', 'hero' ],
		[ 'calm-lagoon', 'qa-calm-lagoon.png', 'lagoon' ],
		[ 'golden-hour', 'qa-golden-hour.png', 'sunward' ],
		[ 'storm-front', 'qa-storm-front.png', 'high' ],
		[ 'moonlit', 'qa-moonlit.png', 'hero' ],
		[ 'trade-winds', 'qa-trade-winds.png', 'hero' ],
		[ 'coral-shallows', 'qa-coral-shallows.png', 'lagoon' ],
		[ 'arctic', 'qa-arctic.png', 'low' ],
		[ 'dusk', 'qa-dusk.png', 'sunward' ],
		[ 'sea-fog', 'qa-sea-fog.png', 'hero' ],
		[ 'open-sea', 'qa-vessel.png', 'vessel' ],
		[ 'open-sea', 'qa-boat-side.png', 'boatSide' ],
		[ 'open-sea', 'qa-boat-low.png', 'boatLow' ],
		[ 'open-sea', 'qa-boat-bow.png', 'boatBow' ],
		[ 'open-sea', 'qa-boat-stern.png', 'boatStern' ],
		[ 'open-sea', 'qa-boat-top.png', 'boatTop' ],
	];

	for ( const [ preset, file, view ] of presets ) {

		await chrome.eval( setState( { preset, view } ) );
		out[ file ] = await capture( chrome, file );
		console.log( '  captured', file );

	}

	// Underwater: the lagoon has a visible bottom, the open sea does not.
	const underwater = [
		[ 'calm-lagoon', 'qa-underwater.png', 'under' ],
		[ 'calm-lagoon', 'qa-underwater-up.png', 'underUp' ],
		[ 'open-sea', 'qa-underwater-open.png', 'underDeep' ],
	];

	for ( const [ preset, file, view ] of underwater ) {

		await chrome.eval( setState( { preset, view } ) );
		out[ file ] = await capture( chrome, file, { settle: 8 } );
		console.log( '  captured', file );

	}

	// Forced WebGL 2 path — a separate page load, so re-boot and re-check.
	await chrome.goto( ORIGIN + '/?forcewebgl=1' );
	// A freshly navigated page has not composited yet; capturing immediately can
	// read an empty surface.
	await sleep( 1500 );
	await chrome.eval( setState( { preset: 'open-sea', view: 'hero' } ) );
	out[ 'qa-fallback.png' ] = await capture( chrome, 'qa-fallback.png' );
	out.fallbackBackend = await chrome.eval( 'window.__app.backendName' );
	out.fallbackErrors = chrome.consoleErrors.slice();
	console.log( '  captured qa-fallback.png  backend =', out.fallbackBackend );

	return out;

}

async function perf( chrome, seconds ) {

	const runs = [];

	// [ width, height, dpr, preset, quality, label ]
	//
	// The last two runs exist because a display-synced 60 fps tells you nothing
	// about headroom — it only says the frame fitted. Pushing pixels (4x the
	// count) and geometry (Ultra) until the frame time leaves the vsync floor is
	// what turns "60 fps" into an actual measurement.
	const cases = [
		[ 1920, 1080, 1, 'open-sea', 'high', '1920x1080 high' ],
		[ 1280, 720, 1, 'open-sea', 'high', '1280x720 high' ],
		[ 1920, 1080, 1, 'storm-front', 'high', '1920x1080 high storm' ],
		[ 1920, 1080, 1, 'storm-front', 'low', '1920x1080 low storm' ],
		[ 1920, 1080, 2, 'open-sea', 'ultra', '3840x2160 ultra (headroom probe)' ],
	];

	for ( const [ w, h, dpr, preset, quality, label ] of cases ) {

		await chrome.setViewport( w, h, dpr );
		await chrome.goto( ORIGIN + '/' );
		await chrome.eval( setState( { preset, view: 'hero', quality } ) + '; window.__set({ autoQuality:false })' );

		// Let pipelines warm and the frame time settle before sampling.
		await sleep( 4000 );

		const r = await chrome.eval( `window.__perf(${seconds}, ${JSON.stringify( label )})` );
		runs.push( r );
		console.log( `  ${label}: ${r.avgFps} fps avg, ${r.avgMs} ms, 1% low ${r.onePercentLowFps} fps, ${r.drawingBuffer}` );

	}

	// Underwater carries an extra full-screen pass; worth its own number.
	// If that number matters, use `abshafts` rather than this one — see below.
	await chrome.setViewport( 1920, 1080, 1 );
	await chrome.goto( ORIGIN + '/' );
	await chrome.eval( setState( { preset: 'calm-lagoon', view: 'under', quality: 'high' } ) + '; window.__set({ autoQuality:false })' );
	await sleep( 4000 );
	const uw = await chrome.eval( `window.__perf(${Math.min( seconds, 20 )}, "1920x1080 high underwater")` );
	runs.push( uw );
	console.log( `  underwater: ${uw.avgFps} fps avg, ${uw.avgMs} ms, 1% low ${uw.onePercentLowFps} fps` );

	return runs;

}

async function stress( chrome ) {

	await chrome.setViewport( 1920, 1080, 1 );
	await chrome.goto( ORIGIN + '/' );

	const result = {};

	// --- resize x5 -------------------------------------------------------
	const sizes = [ [ 1280, 720 ], [ 900, 1400 ], [ 1920, 1080 ], [ 640, 480 ], [ 1600, 900 ] ];

	for ( const [ w, h ] of sizes ) {

		await chrome.setViewport( w, h, 1 );
		await sleep( 400 );

	}

	result.resize = await chrome.eval( 'window.__state()' );
	result.resizeErrors = chrome.consoleErrors.slice();

	// --- preset switching, measuring the worst frame across transitions ---
	await chrome.setViewport( 1920, 1080, 1 );
	await sleep( 600 );

	result.presetSwitch = await chrome.eval( `
		(async () => {
			const ids = ['calm-lagoon','open-sea','golden-hour','storm-front','moonlit','open-sea'];
			const worst = [];
			for (const id of ids) {
				window.__app.applyPreset(id, false);
				const t0 = performance.now();
				let peak = 0, last = t0;
				await new Promise(res => {
					const tick = () => {
						const now = performance.now();
						peak = Math.max(peak, now - last);
						last = now;
						if (now - t0 < 2200) requestAnimationFrame(tick); else res();
					};
					requestAnimationFrame(tick);
				});
				worst.push({ id, worstFrameMs: +peak.toFixed(1) });
			}
			return worst;
		})()
	` );

	// --- crossing the waterline slowly, both ways ------------------------
	result.mediumCrossing = await chrome.eval( `
		(() => {
			const app = window.__app;
			const flips = [];
			let prev = app.underwater;
			// 0.04 m per step through the surface and back, watching for chatter.
			for (let i = 0; i < 400; i++) {
				const y = 3.0 - Math.abs(200 - i) * 0.02;
				app.controls.position.y = y;
				app.controls.applyToCamera();
				window.__advance(1/60, 1/60);
				if (app.underwater !== prev) { flips.push({ i, y: +y.toFixed(3), to: app.underwater }); prev = app.underwater; }
			}
			return { flips, flipCount: flips.length };
		})()
	` );

	// --- hidden tab, then return -----------------------------------------
	await chrome.send( 'Emulation.setPageVisibilityOverride', { visibility: 'hidden' } ).catch( () => {} );
	await sleep( 2500 );
	await chrome.send( 'Emulation.setPageVisibilityOverride', { visibility: 'visible' } ).catch( () => {} );
	await sleep( 1500 );

	result.afterHidden = await chrome.eval( 'window.__state()' );

	// --- memory over a sustained run --------------------------------------
	const mem0 = await chrome.eval( '(performance.memory ? performance.memory.usedJSHeapSize : 0)' );
	await sleep( 20000 );
	const mem1 = await chrome.eval( '(performance.memory ? performance.memory.usedJSHeapSize : 0)' );
	result.memory = { startBytes: mem0, endBytes: mem1, deltaBytes: mem1 - mem0 };

	result.consoleErrors = chrome.consoleErrors.slice();
	result.pageErrors = chrome.pageErrors.slice();

	return result;

}

/* -------------------------------------------------------------------- main */

/**
 * Interleaved A/B on the underwater light-shaft march.
 *
 * This exists because every unpaired performance number this project has taken
 * on a warm machine has been wrong. Two back-to-back runs gave 38.6 fps at
 * eight march steps and 31.9 at six — the cheaper build measuring slower — which
 * is a thermal ramp swamping the effect. An absolute number cannot separate the
 * two; a *paired* one can.
 *
 * So: two variants differing only by a URL flag, alternated inside one session,
 * with the order flipped every round. A monotonic drift then lands on both arms
 * roughly equally and cancels in the per-round difference. What is reported is
 * the median of the paired differences, not the difference of the medians —
 * the former is what survives a drift, the latter is not.
 */
async function abShafts( chrome, seconds, rounds = 3, opts = {} ) {

	const flag = opts.flag ?? 'noshafts';
	const view = opts.view ?? 'under';
	const preset = opts.preset ?? 'calm-lagoon';

	// Pixel ratio, because pairing does not rescue a measurement that is pinned.
	// The first A/B on the refraction returned a delta of exactly zero in all
	// three rounds — both arms sat on the 16.67 ms vsync cap, where nothing below
	// it is observable no matter how carefully the arms are interleaved. A term
	// that costs anything at all only becomes visible once the frame leaves the
	// cap, which at 1080p means pushing four times the pixels.
	const dpr = opts.dpr ?? 1;
	const arms = { on: '/', off: `/?${flag}=1` };
	const ms = { on: [], off: [] };
	const paired = [];

	for ( let r = 0; r < rounds; r ++ ) {

		const order = r % 2 === 0 ? [ 'on', 'off' ] : [ 'off', 'on' ];
		const round = {};

		for ( const arm of order ) {

			await chrome.setViewport( 1920, 1080, dpr );
			await chrome.goto( ORIGIN + arms[ arm ] );
			await chrome.eval(
				setState( { preset, view, quality: 'high' } )
				+ '; window.__set({ autoQuality:false })'
			);
			await sleep( 4000 );

			const s = await chrome.eval( `window.__perf(${seconds}, "${flag}-${arm}-r${r}")` );
			ms[ arm ].push( s.avgMs );
			round[ arm ] = s.avgMs;
				console.log( `  r${r} ${flag} ${arm.padEnd( 3 )}: ${s.avgFps} fps, ${s.avgMs} ms, 1% low ${s.onePercentLowFps}` );

		}

		paired.push( Number( ( round.on - round.off ).toFixed( 2 ) ) );

	}

	const median = ( a ) => [ ...a ].sort( ( x, y ) => x - y )[ Math.floor( a.length / 2 ) ];

	const cost = median( paired );
	console.log( `  paired deltas (on - off, ms): ${paired.join( ', ' )}` );
	console.log( `  the term costs ${cost} ms/frame (median of paired), off = ${median( ms.off )} ms, on = ${median( ms.on )} ms` );

	return { flag, view, preset, seconds, rounds, msOn: ms.on, msOff: ms.off, pairedDeltaMs: paired, costMs: cost };

}

const command = process.argv[ 2 ] || 'smoke';
const arg = Number( process.argv[ 3 ] );

const chrome = new Chrome();
const report = { command, origin: ORIGIN, startedAt: new Date().toISOString() };

try {

	console.log( `launching Chrome (headless) against ${ORIGIN} …` );
	await chrome.launch( { width: 1920, height: 1080 } );

	// QA_VIEWPORT=WxH lets the eval/shots commands run at a different size, which
	// is how the small-screen panel layout gets checked.
	const [ vw, vh ] = ( process.env.QA_VIEWPORT || '1920x1080' ).split( 'x' ).map( Number );
	await chrome.setViewport( vw || 1920, vh || 1080, 1 );

	const version = await chrome.eval( 'navigator.userAgent' );
	report.userAgent = version;
	console.log( 'UA:', version );

	if ( command === 'soak' ) {

		// acceptance.md asks for five minutes without a one-way memory climb.
		const minutes = Number.isFinite( arg ) && arg > 0 ? arg : 5;
		console.log( `soak (${minutes} min) …` );

		await chrome.setViewport( 1920, 1080, 1 );
		await chrome.goto( ORIGIN + '/' );
		await chrome.eval( setState( { preset: 'open-sea', view: 'hero' } ) );
		await sleep( 5000 );

		const samples = [];
		const steps = Math.max( 2, Math.round( minutes * 4 ) );   // every 15 s

		for ( let i = 0; i < steps; i ++ ) {

			// Keep it doing real work: rotate through presets and dip under water.
			if ( i % 4 === 1 ) await chrome.eval( 'window.__app.applyPreset("storm-front")' );
			if ( i % 4 === 2 ) await chrome.eval( setState( { view: 'underDeep' } ) );
			if ( i % 4 === 3 ) await chrome.eval( 'window.__app.applyPreset("calm-lagoon")' );
			if ( i % 4 === 0 && i > 0 ) await chrome.eval( 'window.__app.applyPreset("open-sea")' + '; ' + setState( { view: 'hero' } ) );

			await sleep( 15000 );

			samples.push( await chrome.eval( `({
				t: ${i * 15},
				heap: performance.memory ? performance.memory.usedJSHeapSize : 0,
				fps: +window.__app.diagnostics.fps.toFixed(1),
				errors: window.__app.consoleErrors.length
			})` ) );

			process.stdout.write( `  ${( i + 1 ) * 15}s heap=${( samples[ i ].heap / 1048576 ).toFixed( 1 )}MB fps=${samples[ i ].fps}\n` );

		}

		const first = samples[ 0 ].heap;
		const last = samples[ samples.length - 1 ].heap;
		const peak = Math.max( ...samples.map( ( s ) => s.heap ) );

		report.soak = {
			minutes, samples,
			startMB: +( first / 1048576 ).toFixed( 2 ),
			endMB: +( last / 1048576 ).toFixed( 2 ),
			peakMB: +( peak / 1048576 ).toFixed( 2 ),
			growthMB: +( ( last - first ) / 1048576 ).toFixed( 2 ),
			consoleErrors: chrome.consoleErrors.slice(),
			pageErrors: chrome.pageErrors.slice(),
		};

		console.log( `  start ${report.soak.startMB}MB -> end ${report.soak.endMB}MB (peak ${report.soak.peakMB}MB), errors ${chrome.consoleErrors.length}` );

	}

	if ( command === 'fft' ) {

		// Verify the GPU transform against a CPU DFT before anything is built on
		// top of it. A subtly-wrong FFT still yields a plausible-looking ocean.
		await chrome.send( 'Page.navigate', { url: ORIGIN + '/tools/fft-test.html' } );

		const deadline = Date.now() + 60000;
		while ( Date.now() < deadline ) {

			if ( await chrome.eval( 'window.__ready === true' ).catch( () => false ) ) break;
			await sleep( 250 );

		}

		report.fft = [];

		for ( const [ N, planes, sign ] of [ [ 8, 1, 1 ], [ 16, 3, 1 ], [ 16, 3, - 1 ], [ 64, 2, 1 ], [ 256, 1, 1 ] ] ) {

			const r = await chrome.eval( `window.__fftTest(${N}, ${planes}, ${sign})` );
			report.fft.push( r );
			console.log( `  N=${String( N ).padStart( 3 )} planes=${planes} sign=${sign >= 0 ? '+1' : '-1'}  ` +
				`maxRel=${r.maxRelError}  ${r.pass ? 'PASS' : 'FAIL'}` );

		}

		report.spectrum = await chrome.eval( 'window.__spectrumTest(64)' );
		console.log( `  spectrum hermitian: ${report.spectrum.pass ? 'PASS' : 'FAIL'} ` +
			report.spectrum.cascades.map( ( c ) => `L=${c.size}:${c.maxHermitianError}` ).join( ' ' ) );

		report.ocean = await chrome.eval( 'window.__oceanTest(64, 2.0)' );
		console.log( `  ocean end-to-end: Hs ${report.ocean.measuredSignificantHeight} m for requested 2.0 m ` +
			`(ratio ${report.ocean.ratio})  ${report.ocean.pass ? 'PASS' : 'FAIL'}` );

		report.fftAllPass = report.fft.every( ( r ) => r.pass ) && report.spectrum.pass && report.ocean.pass;
		console.log( report.fftAllPass ? '  all spectral checks PASS' : '  SPECTRAL VERIFICATION FAILED' );

	}

	if ( command === 'strip' ) {

		// Contact sheets. One image per scenario, eight frames of motion in each.
		await chrome.goto( ORIGIN + '/' );

		const cases = [
			[ 'open-sea', 'wide', 'qa-motion-wide.png', 0.15 ],
			[ 'open-sea', 'boatStern', 'qa-motion-wake.png', 0.35 ],
			[ 'storm-front', 'high', 'qa-motion-storm.png', 0.15 ],
			[ 'trade-winds', 'vessel', 'qa-motion-vessel.png', 0.30 ],
		];

		for ( const [ preset, view, file, dt ] of cases ) {

			// vesselHove:false — the boat has to be moving, or the wake and the
			// heading are exactly the things the sheet cannot show.
			await chrome.eval( setState( { preset, view } ) + '; window.__set({ vesselHove:false, autoQuality:false })' );
			await sleep( 2500 );

			const url = await chrome.eval( `window.__strip({ frames:8, dt:${dt}, cols:4 })` );
			writeFileSync( join( ROOT, 'qa', file ), Buffer.from( url.split( ',' )[ 1 ], 'base64' ) );
			console.log( '  wrote', file );

		}

		report.strips = cases.map( ( c ) => c[ 2 ] );

	}

	if ( command === 'flicker' ) {

		// Sub-pixel sparkle, at native resolution. See the note on __flicker for
		// why the mean is useless here and the tail is not.
		await chrome.setViewport( 1920, 1080, 1 );
		await chrome.goto( ORIGIN + '/' );

		const out = {};

		for ( const [ preset, view ] of [ [ 'open-sea', 'wide' ], [ 'open-sea', 'wideHigh' ], [ 'storm-front', 'wide' ] ] ) {

			await chrome.eval( setState( { preset, view } ) + '; window.__set({ autoQuality:false })' );
			await sleep( 2500 );

			// Water only: the sky above the horizon has its own noise sources.
			const r = await chrome.eval( 'window.__flicker({ top:0.45, bottom:1.0 })' );
			out[ `${preset}/${view}` ] = r;
			console.log( `  ${preset}/${view}: mean ${r.meanDelta}  p99.9 ${r.p999Delta}  spark ${( r.sparkFraction * 100 ).toFixed( 3 )}%  @${r.resolution}` );

		}

		report.flicker = out;

	}

	if ( command === 'eval' ) {

		// One-off diagnostics against a real, visible page. The embedded preview
		// browser cannot be trusted for this: it reports the page as hidden, so it
		// never composites and canvas readbacks come back one or more frames stale.
		if ( process.env.QA_REDUCED_MOTION ) {

			await chrome.send( 'Emulation.setEmulatedMedia', {
				features: [ { name: 'prefers-reduced-motion', value: 'reduce' } ],
			} );

		}

		await chrome.goto( ORIGIN + '/' );
		const expr = process.argv.slice( 3 ).join( ' ' );
		report.result = await chrome.eval( `(async () => { ${expr} })()` );
		console.log( JSON.stringify( report.result, null, '\t' ) );

	}

	if ( command === 'smoke' || command === 'all' ) {

		console.log( 'smoke …' );
		report.smoke = await smoke( chrome );
		console.log( '  backend:', report.smoke.state.backend, '| console errors:', report.smoke.consoleErrors.length );

	}

	if ( command === 'shots' || command === 'all' ) {

		console.log( 'captures …' );
		report.shots = await shots( chrome );

	}

	if ( command === 'perf' || command === 'all' ) {

		const seconds = Number.isFinite( arg ) && arg > 0 ? arg : 30;
		console.log( `perf (${seconds}s per sample) …` );
		report.perf = await perf( chrome, seconds );

	}

	if ( command === 'abshafts' ) {

		// node tools/qa.mjs abshafts [seconds] [flag] [view] [preset]
		const seconds = Number.isFinite( arg ) && arg > 0 ? arg : 12;
		const flag = process.argv[ 4 ] || 'noshafts';
		const view = process.argv[ 5 ] || 'under';
		const preset = process.argv[ 6 ] || 'calm-lagoon';
		const dpr = Number( process.argv[ 7 ] ) || 1;
		console.log( `abshafts (${seconds}s, 3 interleaved rounds, ?${flag}=1, ${preset}/${view}, dpr ${dpr}) …` );
		report.abshafts = await abShafts( chrome, seconds, 3, { flag, view, preset, dpr } );

	}

	if ( command === 'stress' || command === 'all' ) {

		console.log( 'stress …' );
		report.stress = await stress( chrome );
		console.log( '  preset transition worst frames:',
			report.stress.presetSwitch.map( ( p ) => `${p.id}=${p.worstFrameMs}ms` ).join( ' ' ) );
		console.log( '  waterline flips:', report.stress.mediumCrossing.flipCount );

	}

	report.finishedAt = new Date().toISOString();
	report.ok = true;

} catch ( err ) {

	report.ok = false;
	report.error = err.message;
	console.error( '\nFAILED:', err.message );

} finally {

	mkdirSync( join( ROOT, 'qa' ), { recursive: true } );
	writeFileSync( join( ROOT, 'qa', `report-${command}.json` ), JSON.stringify( report, null, '\t' ) );
	console.log( `\nwrote qa/report-${command}.json` );
	chrome.close();
	await sleep( 400 );
	process.exit( report.ok ? 0 : 1 );

}
