// Application entry point: bring-up, the frame loop, and everything that has to
// coordinate across subsystems (quality, pause, preset changes, the above/below
// water transition, error reporting).

import {
	BackSide, Mesh, MeshBasicNodeMaterial, PerspectiveCamera, Scene, SphereGeometry,
	setConsoleFunction,
} from 'three/webgpu';
import { normalize, positionLocal } from 'three/tsl';

import { DPR_CAP, ViewportSizer, backendName, createRenderer, probeWebGPU } from './core/renderer.js';
import { Diagnostics, installQAHooks } from './core/diagnostics.js';
import { clamp, damp } from './core/util.js';
import { createEnv, syncUniforms } from './env/uniforms.js';
import { createAerialSkyFn, createReflectionSkyFn, createSkyFn } from './env/sky.js';
import { CloudLayer } from './env/clouds.js';
import { DEFAULT_PRESET, PRESETS, PresetMixer } from './env/presets.js';
import { GEOMETRY_TIERS, createOceanGeometry } from './ocean/geometry.js';
import { WaveField } from './ocean/waves.js';
import { FOAM_TIERS, FoamHistory } from './ocean/foam.js';
import { SPECTRAL_TIERS, SpectralOcean } from './ocean/spectral.js';
import { Ocean, createOceanMaterial } from './ocean/material.js';
import { Buoys } from './props/buoys.js';
import { Vessel } from './props/vessel.js';
import { PropReflection } from './props/reflection.js';
import { UnderwaterPipeline } from './underwater/pipeline.js';
import { Particles, Seabed } from './underwater/scenery.js';
import { FlyControls } from './input/controls.js';
import { Hud, Panel } from './ui/panel.js';

const QUALITY = {
	low: { geometry: 'low', foam: 'low', waves: 14, cloudOctaves: 3, dpr: DPR_CAP.low, foamHistory: false, particles: 900, volumetricClouds: false, cloudSteps: 0, bloom: false },
	medium: { geometry: 'medium', foam: 'medium', waves: 18, cloudOctaves: 4, dpr: DPR_CAP.medium, foamHistory: true, particles: 1800, volumetricClouds: true, cloudSteps: 16, bloom: true },
	high: { geometry: 'high', foam: 'high', waves: 20, cloudOctaves: 5, dpr: DPR_CAP.high, foamHistory: true, particles: 2600, volumetricClouds: true, cloudSteps: 24, bloom: true },
	ultra: { geometry: 'ultra', foam: 'ultra', waves: 24, cloudOctaves: 6, dpr: DPR_CAP.ultra, foamHistory: true, particles: 4200, volumetricClouds: true, cloudSteps: 36, bloom: true },
};

const WAVE_SEED = 20250731;

/** Largest simulation step we will take. Guards the tab-return time jump. */
const MAX_DT = 1 / 20;

class App {

	constructor() {

		this.canvas = document.getElementById( 'view' );
		this.bootEl = document.getElementById( 'boot' );
		this.bootStep = document.getElementById( 'boot-step' );

		this.consoleErrors = [];
		this.consoleWarnings = [];

		this.env = createEnv();
		this.diagnostics = new Diagnostics();

		this.quality = 'high';
		this.presetId = DEFAULT_PRESET;

		this.paused = false;
		this.orbiting = false;
		this.autoQuality = true;
		this.showStats = false;
		this.forceWebGL = new URLSearchParams( location.search ).has( 'forcewebgl' );

		this.waveTime = 0;
		this._frameDt = 1 / 60;
		this.surfaceY = 0;
		this.underwater = false;
		this.underwaterFactor = 0;

		this._lastFrame = 0;
		this._statsTimer = 0;
		this._autoTimer = 0;
		this._autoAccum = 0;
		this._autoFrames = 0;
		this._running = false;

	}

	/* ================================================================ boot */

	step( text ) {

		if ( this.bootStep ) this.bootStep.textContent = text;

	}

	async init() {

		this.step( 'Checking graphics capability…' );

		const probe = await probeWebGPU();
		this.webgpuAvailable = probe.ok;

		if ( ! probe.ok && ! this.forceWebGL ) {

			// Not fatal: WebGPURenderer falls back to a WebGL 2 backend on its own.
			// Say so rather than letting the user wonder why it looks different.
			this.webgpuReason = probe.reason;

		}

		this.step( probe.ok && ! this.forceWebGL ? 'Initialising WebGPU…' : 'Initialising WebGL 2…' );

		this.renderer = await createRenderer( this.canvas, {
			forceWebGL: this.forceWebGL,
			onDeviceLost: ( info ) => this.onDeviceLost( info ),
			onBackendError: ( err ) => this.recordError( 'backend', err?.message ?? String( err ) ),
		} );

		this.backendName = backendName( this.renderer );

		this.step( 'Building environment…' );

		this.scene = new Scene();
		this.camera = new PerspectiveCamera( 55, 1, 0.1, 120000 );

		this.sizer = new ViewportSizer( this.renderer, this.camera );
		this.sizer.setDprCap( QUALITY[ this.quality ].dpr );

		this.controls = new FlyControls( this.camera, this.canvas );

		// Presets are applied before any material is built so the first frame is
		// already correct — no flash of default colours.
		this.mixer = new PresetMixer( this.env );
		this.mixer.apply( this.presetId, true );
		syncUniforms( this.env );

		this.buildSky();

		this.step( 'Generating ocean…' );
		this.buildOcean();

		this.step( 'Building underwater…' );

		this.seabed = new Seabed( this.env );
		this.scene.add( this.seabed.mesh );

		this.particles = new Particles( this.env, QUALITY[ this.quality ].particles );
		this.scene.add( this.particles.points );

		// Bloom is WebGPU-only. Its RTT chain does not reach the canvas on the
		// WebGL 2 backend — the scene renders (no errors, correct triangle count)
		// but the composited result never presents. The fallback is a
		// compatibility path rather than the showcase, so it drops the effect
		// instead of blocking on it; this is recorded as a known limitation.
		this.underwaterPipeline = new UnderwaterPipeline(
			this.renderer, this.scene, this.camera, this.env,
			{ bloom: QUALITY[ this.quality ].bloom && this.renderer.backend?.isWebGPUBackend === true }
		);
		this.underwaterPipeline.setSize(
			this.sizer.width * this.sizer.effectiveDpr,
			this.sizer.height * this.sizer.effectiveDpr
		);

		this.step( 'Compiling shaders…' );
		// Compile up front so the first visible frame is not a multi-hundred-
		// millisecond stall.
		await this.renderer.compileAsync( this.scene, this.camera );

		this.ui = new Panel( this );
		this.hud = new Hud();
		this.ui.setStatsVisible( this.showStats );

		this.bindKeys();
		this.bindVisibility();

		installQAHooks( this );

		this.renderer.toneMappingExposure = this.env.params.exposure;
		this.sizer.onResize = ( w, h ) => {

			this.underwaterPipeline?.setSize( w, h );
			this.clouds?.setSize( w, h );
			this.propReflection?.setSize( w, h );

		};
		this.sizer.apply();

		this._running = true;
		this._lastFrame = performance.now();
		this.renderer.setAnimationLoop( ( t ) => this.frame( t ) );

		this.hideBoot();

		if ( this.webgpuReason ) {

			this.ui.toastMessage( 'WebGPU unavailable — running on WebGL 2', 4200 );

		}

		this.ui.showHint( 5000 );
		this.updateStatus();

	}

	hideBoot() {

		this.bootEl.classList.add( 'fading' );
		setTimeout( () => { this.bootEl.hidden = true; }, 560 );

	}

	/* =============================================================== scene */

	buildSky() {

		const tier = QUALITY[ this.quality ];
		const octaves = tier.cloudOctaves;

		// The marched cloud slab renders into its own half-resolution target; the
		// dome only composites it. Gated to WebGPU for the same reason as bloom —
		// the fallback is a compatibility path, and it keeps the flat sheet.
		//
		// The reflection and aerial variants keep the flat sheet regardless.
		// Reflected clouds are blurred by surface roughness anyway, and the cloud
		// target is screen-space: there is no reflected pixel to look up in it.
		const wantClouds = tier.volumetricClouds && this.renderer.backend?.isWebGPUBackend === true;

		// ?cloudscale=<0..1> overrides the cloud target's resolution fraction, and
		// ?cloudscale=0 disables the layer outright. Tuning aid: it is the only way
		// to attribute frame time to the march rather than to the rest of the scene,
		// since at 1080p everything else sits under the vsync cap and is invisible.
		const scaleParam = parseFloat( new URLSearchParams( location.search ).get( 'cloudscale' ) );
		// 0.4 was chosen when a cloud was assumed to be a purely low-frequency
		// object. It is not: the lit rim where the sun grazes a cumulus turret is
		// a *sharp* feature, and at 0.4 it magnified into the soft cotton-wool
		// blobs that were the weakest thing in every wide shot. 0.52 costs 1.7x
		// the march and buys back the edge.
		const cloudScale = Number.isFinite( scaleParam ) ? scaleParam : 0.40;

		this.clouds = wantClouds && cloudScale > 0
			? new CloudLayer( this.env, {
				cloudOctaves: octaves,
				marchSteps: parseInt( new URLSearchParams( location.search ).get( 'cloudsteps' ), 10 ) || tier.cloudSteps,
				scale: cloudScale,
			} )
			: null;

		if ( this.clouds ) {

			this.clouds.setSize(
				this.sizer.width * this.sizer.effectiveDpr,
				this.sizer.height * this.sizer.effectiveDpr
			);

		}

		this.skyFns = {
			dome: createSkyFn( this.env, {
				cloudOctaves: octaves,
				cloudTexture: this.clouds ? this.clouds.texture : null,
				cloudTexel: this.clouds ? this.clouds.uTexel : null,
			} ),
			reflection: createReflectionSkyFn( this.env ),
			aerial: createAerialSkyFn( this.env ),
		};

		const material = new MeshBasicNodeMaterial();
		material.name = 'Sky';
		material.side = BackSide;
		material.depthWrite = false;
		material.depthTest = false;
		material.fog = false;
		// The dome is centred on the camera, so its local position *is* the view
		// direction — no matrix work, no extra varying.
		material.colorNode = this.skyFns.dome( normalize( positionLocal ) );

		this.skyMesh = new Mesh( new SphereGeometry( 4000, 48, 24 ), material );
		this.skyMesh.name = 'SkyDome';
		this.skyMesh.frustumCulled = false;
		this.skyMesh.matrixAutoUpdate = false;
		// Drawn first, writes no depth: everything else composites over it.
		this.skyMesh.renderOrder = - 1000;

		this.scene.add( this.skyMesh );

	}

	buildOcean() {

		const tier = QUALITY[ this.quality ];
		const geometryInfo = createOceanGeometry( GEOMETRY_TIERS[ tier.geometry ] );

		this.field = new WaveField( WAVE_SEED, tier.waves );
		this.field.build( this.env.params, geometryInfo.growth );
		this.geometryGrowth = geometryInfo.growth;

		// Spectral cascades need compute shaders, so they are WebGPU-only. The
		// Gerstner field above is not a stopgap — it is the engine for the WebGL 2
		// fallback and the Low tier, and it stays live either way because the
		// CPU-side water-line query reads from it.
		const spectralTier = SPECTRAL_TIERS[ this.quality ];
		this.spectral = ( spectralTier && this.renderer.backend?.isWebGPUBackend )
			? new SpectralOcean( this.renderer, this.env, spectralTier.N, WAVE_SEED )
			: null;

		this.waveEngine = this.spectral ? 'spectral' : 'gerstner';

		// Low tier drops the history buffer entirely and falls back to
		// instantaneous crest foam — one fewer render target and one fewer full
		// wave evaluation per frame.
		this.foam = tier.foamHistory
			? new FoamHistory( this.env, this.field, FOAM_TIERS[ tier.foam ], this.spectral?.textures ?? null )
			: null;

		// The reflection target has to exist before the water material is built,
		// because the material samples it. Only on the spectral path, which is the
		// only path that has props to reflect.
		// ?noreflect=1 drops the pass. Same reason as ?cloudscale: at 1080p the
		// vsync cap swallows everything under 16.67 ms, so cost can only be
		// attributed by removing the thing and measuring again in the same session.
		const noReflect = new URLSearchParams( location.search ).has( 'noreflect' );

		this.propReflection = ( this.spectral && ! noReflect ) ? new PropReflection() : null;

		if ( this.propReflection ) {

			this.propReflection.setSize(
				this.sizer.width * this.sizer.effectiveDpr,
				this.sizer.height * this.sizer.effectiveDpr
			);

		}

		const material = createOceanMaterial( this.env, this.field, {
			reflection: this.skyFns.reflection,
			aerial: this.skyFns.aerial,
		}, {
			foam: this.foam,
			spectral: this.spectral?.textures ?? null,
			propReflection: this.propReflection ? this.propReflection.texture : null,
		} );

		this.ocean = new Ocean( this.env, this.field, geometryInfo, material );
		this.scene.add( this.ocean.mesh );

		// Scale reference. Only on the spectral path: on the Gerstner fallback the
		// buoys would need their own CPU height solve, and a marker that floats a
		// metre above the water is worse than no marker at all.
		if ( this.spectral ) {

			this.buoys = new Buoys( this.env, this.spectral.textures, 9 );
			this.scene.add( this.buoys.mesh );

			// The hero object. Everything the water does at its boundary — the foam
			// collar, the shadow cast into the column — is driven from uniforms the
			// vessel writes, so it has to exist before the surface material is asked
			// to shade a frame.
			this.vessel = new Vessel( this.env, this.spectral.textures );
			this.scene.add( this.vessel.mesh );
			this.env.u.vesselMix.value = 1;

			this.propReflection?.add( this.vessel.mesh );
			this.propReflection?.add( this.buoys.mesh );

		} else {

			this.buoys = null;
			this.vessel = null;
			this.env.u.vesselMix.value = 0;

		}

	}

	rebuildWaves() {

		this.field.build( this.env.params, this.geometryGrowth );
		this.spectral?.rebuild( this.env.params );
		// The history was accumulated against the old spectrum; keeping it would
		// leave foam sitting where crests no longer are.
		this.foam?.reset();

	}

	/** Full teardown of geometry + materials. Only on an explicit quality change. */
	async setQuality( level ) {

		if ( ! QUALITY[ level ] || level === this.quality ) return;

		this.quality = level;
		this.sizer.setDprCap( QUALITY[ level ].dpr );

		this.scene.remove( this.ocean.mesh );
		this.ocean.dispose();
		this.foam?.dispose();
		this.spectral?.dispose();

		if ( this.buoys ) {

			this.scene.remove( this.buoys.mesh );
			this.buoys.dispose();

		}

		if ( this.vessel ) {

			this.scene.remove( this.vessel.mesh );
			this.vessel.dispose();
			this.vessel = null;

		}

		this.propReflection?.dispose();
		this.propReflection = null;

		this.scene.remove( this.skyMesh );
		this.skyMesh.geometry.dispose();
		this.skyMesh.material.dispose();
		this.clouds?.dispose();
		this.clouds = null;

		this.scene.remove( this.particles.points );
		this.particles.dispose();

		this.buildSky();
		this.buildOcean();

		this.particles = new Particles( this.env, QUALITY[ level ].particles );
		this.scene.add( this.particles.points );

		await this.renderer.compileAsync( this.scene, this.camera );

		this.diagnostics.reset();
		this.ui?.refresh();
		this.updateStatus();

	}

	/* ============================================================ settings */

	getSetting( id ) {

		switch ( id ) {

			case 'quality': return this.quality;
			case 'resolutionScale': return this.sizer.scale;
			case 'autoQuality': return this.autoQuality;
			case 'showStats': return this.showStats;
			case 'forceWebGL': return this.forceWebGL;
			default: return undefined;

		}

	}

	setSetting( id, value ) {

		switch ( id ) {

			case 'quality':
				this.setQuality( value );
				break;

			case 'resolutionScale':
				this.sizer.setScale( value );
				// An explicit choice overrides the automatic system.
				this.autoQuality = false;
				this.ui?.refresh();
				break;

			case 'autoQuality':
				this.autoQuality = value;
				if ( ! value ) this.sizer.setScale( 1 );
				break;

			case 'showStats':
				this.showStats = value;
				this.ui?.setStatsVisible( value );
				break;

			case 'forceWebGL': {

				const url = new URL( location.href );
				if ( value ) url.searchParams.set( 'forcewebgl', '1' );
				else url.searchParams.delete( 'forcewebgl' );
				location.href = url.toString();
				break;

			}

		}

		this.updateStatus();

	}

	applyPreset( id, instant = false ) {

		if ( ! this.mixer.apply( id, instant ) ) return;

		this.presetId = id;
		this.rebuildWaves();
		this.ui?.refresh();
		this.updateStatus();

	}

	setPaused( v ) {

		this.paused = v;
		this.ui?.toastMessage( v ? 'Paused' : 'Running' );

	}

	updateStatus() {

		if ( ! this.ui ) return;
		this.ui.setStatus( `${this.backendName} · ${this.quality} · ${this.waveEngine} · ${this.ocean.triangles / 1000 | 0}k tris` );

	}

	/* ================================================================ loop */

	frame( now ) {

		if ( ! this._running ) return;

		const rawDt = ( now - this._lastFrame ) / 1000;
		this._lastFrame = now;

		this.diagnostics.push( rawDt * 1000 );

		// Clamp so a hidden tab or a long stall does not teleport the simulation.
		const dt = clamp( rawDt, 0, MAX_DT );

		this.update( dt );
		this.render();

		this._statsTimer += rawDt;
		if ( this._statsTimer > 0.5 ) {

			this._statsTimer = 0;
			this.diagnostics.refreshPercentiles();
			if ( this.showStats ) this.hud.update( this );

		}

		if ( this.autoQuality ) this.tuneQuality( rawDt );

	}

	update( dt ) {

		// render() needs the step size for the foam decay/advection maths.
		this._frameDt = dt;

		if ( ! this.paused ) this.waveTime += dt;

		// Preset cross-fade writes into env.params, so it must run before the
		// uniform sync.
		const transitioning = this.mixer.update( dt );

		this.controls.update( dt );

		if ( this.env.dirty || transitioning ) {

			syncUniforms( this.env, dt );
			this.renderer.toneMappingExposure = this.env.params.exposure;
			this.env.dirty = false;
			if ( transitioning ) this.ui?.refresh();

		} else {

			// Clouds still need their drift integrated every frame.
			this.env.u.cloudDrift.value.set(
				this.env._cloudDriftX += this.env.windDirJS.x * this.env.params.cloudSpeed * dt * 0.004,
				this.env._cloudDriftY += this.env.windDirJS.y * this.env.params.cloudSpeed * dt * 0.004
			);

		}

		this.env.u.time.value = this.waveTime;

		this.ocean.follow( this.camera );
		this.skyMesh.position.copy( this.camera.position );
		this.skyMesh.updateMatrix();
		this.skyMesh.updateMatrixWorld( true );

		this.updateMedium( dt );

	}

	/**
	 * Decide whether the camera is above or below the water, against the real
	 * displaced surface rather than y = 0.
	 *
	 * A dead band plus a damped factor is what keeps the transition from
	 * strobing when the viewer floats right at the waterline and a passing crest
	 * crosses the eye several times a second.
	 */
	updateMedium( dt ) {

		const p = this.env.params;

		this.surfaceY = this.field.heightAt(
			this.camera.position.x, this.camera.position.z,
			this.waveTime, p.waveHeight, p.waveChoppy
		);

		const delta = this.camera.position.y - this.surfaceY;

		if ( this.underwater ) {

			if ( delta > 0.16 ) this.underwater = false;

		} else if ( delta < - 0.16 ) {

			this.underwater = true;

		}

		this.underwaterFactor = damp( this.underwaterFactor, this.underwater ? 1 : 0, 9, dt );
		if ( this.underwaterFactor < 1e-3 ) this.underwaterFactor = 0;

		this.env.u.uwFactor.value = this.underwaterFactor;
		this.ocean.setUnderwater( this.underwaterFactor > 0 );

		// How deep the viewer is, for light attenuation in the post pass.
		this.underwaterPipeline?.setCameraDepth( Math.max( 0, this.surfaceY - this.camera.position.y ) );

		// Orbit follows her, so the frame stays composed while she sails.
		if ( this.orbiting && this.vessel ) {

			this.controls.setOrbitTarget( this.env.u.vesselPos.value );

		}

		this.buoys?.update( this.camera );
		this.vessel?.update( this.camera, this.paused ? 0 : this._frameDt );
		this.seabed?.update( this.camera );
		this.particles?.update( this.camera, dt, this.underwaterFactor );

		// The sky dome is meaningless from below; the surface's own Snell window
		// shows the sky instead, and leaving the dome on would put a bright band
		// under the water where the horizon used to be.
		if ( this.skyMesh ) this.skyMesh.visible = this.underwaterFactor < 0.85;

	}

	render() {

		// Spectral cascades first: everything downstream samples their textures.
		if ( this.spectral ) this.spectral.update( this.waveTime, this.env.params );

		// Foam history second: the surface samples the texture this pass writes.
		if ( this.foam && ! this.paused ) this.foam.update( this.renderer, this.camera, this._frameDt );

		// Clouds third — the sky dome composites this target, and underwater the
		// dome is hidden, so there is nothing to draw it for.
		// Both extra passes are gated well before the transition completes. The
		// factor is damped and settles at 0.999-something, so a `< 1` test never
		// actually fired and the submerged camera paid for a sky and a reflection
		// it could not see — eleven frames a second of it.
		const surfaced = this.underwaterFactor < 0.9;

		if ( this.clouds && surfaced ) this.clouds.render( this.renderer, this.camera );

		// Mirrored props, for the same reason and with the same gate: below the
		// surface there is no reflection to see.
		if ( this.propReflection && surfaced ) {

			this.propReflection.render( this.renderer, this.camera );

		}

		// Above water with no bloom there is nothing for the post pipeline to do,
		// so the scene goes straight to the canvas at zero extra cost.
		const needsPost = this.underwaterPipeline
			&& ( this.underwaterFactor > 0 || this.underwaterPipeline.hasBloom );

		if ( needsPost ) {

			this.underwaterPipeline.render();

		} else {

			this.renderer.render( this.scene, this.camera );

		}

	}

	/**
	 * Automatic quality. Resolution scale moves first because it is continuous
	 * and reversible; the tier only changes when scale has bottomed out, since
	 * rebuilding geometry costs a visible hitch.
	 */
	tuneQuality( rawDt ) {

		this._autoAccum += rawDt * 1000;
		this._autoFrames ++;

		if ( this._autoFrames < 90 ) return;

		const avg = this._autoAccum / this._autoFrames;
		this._autoAccum = 0;
		this._autoFrames = 0;

		// Budget: 20 ms (50 fps) before we start shedding, 13 ms before we
		// consider giving resolution back.
		if ( avg > 20 ) {

			if ( this.sizer.scale > 0.6 ) {

				this.sizer.setScale( this.sizer.scale - 0.1 );
				this.ui?.refresh();

			} else {

				const order = [ 'ultra', 'high', 'medium', 'low' ];
				const i = order.indexOf( this.quality );
				if ( i >= 0 && i < order.length - 1 ) {

					this.setQuality( order[ i + 1 ] );
					this.sizer.setScale( 1 );
					this.ui?.toastMessage( `Quality lowered to ${order[ i + 1 ]}` );

				}

			}

		} else if ( avg < 13 && this.sizer.scale < 1 ) {

			this.sizer.setScale( Math.min( 1, this.sizer.scale + 0.05 ) );
			this.ui?.refresh();

		}

	}

	/* ============================================================== input */

	bindKeys() {

		window.addEventListener( 'keydown', ( e ) => {

			if ( e.metaKey || e.ctrlKey || e.altKey ) return;
			if ( e.target instanceof HTMLInputElement ) return;

			switch ( e.code ) {

				case 'KeyH':
					this.ui.toggleVisible();
					break;

				case 'KeyP':
					this.setPaused( ! this.paused );
					break;

				case 'KeyR':
					this.orbiting = false;
					this.controls.setOrbitTarget( null );
					this.controls.reset();
					this.ui.toastMessage( 'Camera reset' );
					break;

				case 'KeyO':
					if ( ! this.vessel ) {

						this.ui.toastMessage( 'No vessel to orbit on this backend' );
						break;

					}

					this.orbiting = ! this.orbiting;
					this.controls.setOrbitTarget( this.orbiting ? this.env.u.vesselPos.value : null );
					this.ui.toastMessage( this.orbiting ? 'Orbit — drag to swing, wheel to dolly' : 'Fly' );
					break;

				case 'KeyF':
					this.setSetting( 'showStats', ! this.showStats );
					this.ui.refresh();
					break;

				case 'Slash':
					if ( e.shiftKey ) this.ui.showHint( 6000 );
					break;

				default: {

					// 1-9 and 0 jump straight to a preset.
					const m = /^Digit([0-9])$/.exec( e.code );
					if ( m ) {

						const index = m[ 1 ] === '0' ? 9 : Number( m[ 1 ] ) - 1;
						const preset = PRESETS[ index ];
						if ( preset ) {

							this.applyPreset( preset.id );
							this.ui.toastMessage( preset.label );

						}

					}

				}

			}

		} );

	}

	bindVisibility() {

		document.addEventListener( 'visibilitychange', () => {

			if ( document.hidden ) {

				// Stop submitting work entirely while hidden.
				this.renderer.setAnimationLoop( null );
				this._running = false;

			} else {

				this._running = true;
				this._lastFrame = performance.now();
				this.diagnostics.reset();
				this.renderer.setAnimationLoop( ( t ) => this.frame( t ) );

			}

		} );

	}

	/* ============================================================== errors */

	recordError( source, message ) {

		const entry = `[${source}] ${message}`;
		if ( this.consoleErrors.length < 200 ) this.consoleErrors.push( entry );

	}

	onDeviceLost( info ) {

		this._running = false;
		this.renderer.setAnimationLoop( null );
		this.recordError( 'device', info?.message ?? 'device lost' );

		showFatal(
			'Graphics device lost',
			'The browser dropped the GPU device. This usually means the driver reset, ' +
			'the tab was starved of GPU memory, or the machine went to sleep.',
			info?.message ?? ''
		);

	}

}

/* ====================================================================== */

function showFatal( title, message, detail ) {

	const el = document.getElementById( 'fatal' );
	document.getElementById( 'fatal-title' ).textContent = title;
	document.getElementById( 'fatal-message' ).textContent = message;
	document.getElementById( 'fatal-detail' ).textContent = detail || '';
	document.getElementById( 'boot' ).hidden = true;
	el.hidden = false;

}

function installErrorCapture( app ) {

	// three routes its own diagnostics through this hook, which is the only
	// reliable way to catch shader compile failures — they never reach
	// window.onerror.
	setConsoleFunction( ( type, message, ...params ) => {

		const text = [ message, ...params.map( ( p ) => ( typeof p === 'string' ? p : '' ) ) ].join( ' ' ).trim();

		if ( type === 'error' ) {

			app.recordError( 'three', text );
			console.error( message, ...params );

		} else if ( type === 'warn' ) {

			app.consoleWarnings.push( text );
			console.warn( message, ...params );

		} else {

			console.log( message, ...params );

		}

	} );

	window.addEventListener( 'error', ( e ) => {

		app.recordError( 'window', e.message + ( e.filename ? ` (${e.filename}:${e.lineno})` : '' ) );

	} );

	window.addEventListener( 'unhandledrejection', ( e ) => {

		app.recordError( 'promise', e.reason?.message ?? String( e.reason ) );

	} );

}

/* ------------------------------------------------------------- bootstrap */

const app = new App();
window.__app = app;

installErrorCapture( app );

document.getElementById( 'fatal-retry' ).addEventListener( 'click', () => location.reload() );
document.getElementById( 'fatal-fallback' ).addEventListener( 'click', () => {

	const url = new URL( location.href );
	url.searchParams.set( 'forcewebgl', '1' );
	location.href = url.toString();

} );

try {

	await app.init();

} catch ( err ) {

	console.error( err );
	app.recordError( 'init', err?.message ?? String( err ) );

	const noGpu = ! app.webgpuAvailable && ! app.forceWebGL;

	showFatal(
		noGpu ? 'No compatible GPU backend' : 'Could not start the renderer',
		noGpu
			? 'Neither WebGPU nor a WebGL 2 fallback could be initialised in this browser. ' +
			  'A desktop Chrome, Edge or Safari build from the last couple of years is required.'
			: 'The renderer threw during start-up. The message below is the original error.',
		( app.webgpuReason ? app.webgpuReason + '\n\n' : '' ) + ( err?.stack ?? String( err ) )
	);

}
