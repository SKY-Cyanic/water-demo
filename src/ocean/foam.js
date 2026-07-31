// Persistent foam.
//
// Instantaneous crest foam has a giveaway tell: it appears and vanishes with the
// wave that made it, so the sea looks like it is blinking. Real foam outlives the
// breaking crest by many seconds, drifts downwind, and slowly dissolves.
//
// This keeps a low-resolution history of "where foam has recently been" in a
// world-anchored window that follows the camera, and each frame:
//
//     new = decay( advect( reproject( previous ) ) )  +  crest source
//
// reproject   the window moved with the camera, so last frame's texel is not
//             this frame's texel — shift by the origin delta
// advect      foam drifts downwind at a fraction of the wind speed
// decay       exponential, with a lifetime driven by the preset
// source      the same Jacobian-based crest mask the surface shader uses, so
//             the two never disagree about where foam is born
//
// Ping-pong between two targets because a texture cannot be sampled and written
// in the same pass.

import { HalfFloatType, LinearFilter, Mesh, MeshBasicNodeMaterial, OrthographicCamera, PlaneGeometry, RGBAFormat, RenderTarget, Scene, Vector2 } from 'three/webgpu';
import { Fn, float, length, max, min, saturate, smoothstep, step, texture, uniform, uv, vec3, vec4 } from 'three/tsl';

import { createWaveEvaluator, foamFromJacobian } from './waves.js';

export const FOAM_TIERS = {
	low: { size: 128, window: 220 },
	medium: { size: 192, window: 240 },
	high: { size: 256, window: 256 },
	ultra: { size: 384, window: 300 },
};

export class FoamHistory {

	/**
	 * @param {object} env
	 * @param {WaveField} field
	 * @param {object} tier  one of FOAM_TIERS
	 */
	constructor( env, field, tier ) {

		this.env = env;
		this.field = field;
		this.size = tier.size;
		this.window = tier.window;

		const options = {
			format: RGBAFormat,
			type: HalfFloatType,
			depthBuffer: false,
			stencilBuffer: false,
			minFilter: LinearFilter,
			magFilter: LinearFilter,
			generateMipmaps: false,
		};

		this.targets = [
			new RenderTarget( tier.size, tier.size, options ),
			new RenderTarget( tier.size, tier.size, options ),
		];

		for ( const t of this.targets ) t.texture.name = 'FoamHistory';

		this.read = 0;

		/* --- uniforms shared by the accumulation pass and the surface ----- */

		this.uOrigin = uniform( new Vector2() );      // window centre, world XZ
		this.uPrevOrigin = uniform( new Vector2() );
		this.uWindow = uniform( this.window );
		this.uDecay = uniform( 0.99 );
		this.uAdvect = uniform( new Vector2() );      // world-space drift this frame
		this.uSourceGain = uniform( 1 );

		// Bound to whichever target currently holds the finished history.
		this.historyTexture = texture( this.targets[ 0 ].texture );
		this.historyTexture.generateMipmaps = false;

		// The pass reads the *other* target.
		this.prevTexture = texture( this.targets[ 1 ].texture );
		this.prevTexture.generateMipmaps = false;

		this._buildPass();

		this._first = true;
		this._originJS = new Vector2();

	}

	_buildPass() {

		const env = this.env;
		const u = env.u;
		const evaluate = createWaveEvaluator( this.field, env, { earlyOut: false } );

		const material = new MeshBasicNodeMaterial();
		material.name = 'FoamAccumulate';
		material.depthTest = false;
		material.depthWrite = false;

		material.colorNode = Fn( () => {

			const texel = uv().toVar( 'foamUV' );

			// This texel's world position.
			const worldXZ = texel.sub( 0.5 ).mul( this.uWindow ).add( this.uOrigin ).toVar( 'foamWorld' );

			/* --- carry the previous frame forward ------------------------ */

			// Where this world position sat in last frame's window, minus the
			// distance foam has drifted since.
			const prevWorld = worldXZ.sub( this.uAdvect );
			const prevUV = prevWorld.sub( this.uPrevOrigin ).div( this.uWindow ).add( 0.5 ).toVar( 'foamPrevUV' );

			// Anything that came from outside the previous window is unknown, not
			// zero — but treating it as zero is correct here, because the window
			// only ever gains ground the camera is moving toward.
			const inside = step( 0.0, prevUV.x ).mul( step( prevUV.x, 1.0 ) )
				.mul( step( 0.0, prevUV.y ) ).mul( step( prevUV.y, 1.0 ) );

			const carried = this.prevTexture.sample( prevUV ).r.mul( inside ).mul( this.uDecay ).toVar( 'foamCarried' );

			/* --- fresh foam from the crest mask -------------------------- */

			// dist = 0: the history buffer is a top-down world map, so there is no
			// camera distance at which to fade wave components out.
			const wave = evaluate( worldXZ, float( 0.0 ) );

			const source = foamFromJacobian(
				wave.jacobian, length( wave.slope ), u.foamThreshold, u.foamSharpness
			).mul( this.uSourceGain ).toVar( 'foamSource' );

			// max(), not add(): foam saturates. Adding would let a persistent
			// crest run away to a hard white slab.
			const result = max( carried, source ).toVar( 'foamResult' );

			return vec4( vec3( saturate( result ) ), 1.0 );

		} )();

		this.material = material;

		// A plain ortho-camera quad. QuadMesh exists for this, but an explicit
		// scene keeps the render call identical in shape to every other pass.
		this.scene = new Scene();
		this.camera = new OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );
		this.quad = new Mesh( new PlaneGeometry( 2, 2 ), material );
		this.quad.frustumCulled = false;
		this.scene.add( this.quad );

	}

	/**
	 * A TSL node giving foam coverage at a world XZ position.
	 *
	 * Callers must pass the *rest* position, not the displaced one: the history is
	 * indexed by the undisplaced grid, which is also what the accumulation pass
	 * samples the wave field at. Feeding it the displaced position would slide the
	 * foam a metre or two off the crest that made it.
	 */
	sample( restWorldXZ ) {

		const uvNode = restWorldXZ.sub( this.uOrigin ).div( this.uWindow ).add( 0.5 ).toVar( 'foamSampleUV' );

		// Fade out over the last few percent of the window instead of cutting, so
		// the boundary between persistent and instantaneous foam is invisible.
		const edge = min(
			min( smoothstep( 0.0, 0.06, uvNode.x ), smoothstep( 1.0, 0.94, uvNode.x ) ),
			min( smoothstep( 0.0, 0.06, uvNode.y ), smoothstep( 1.0, 0.94, uvNode.y ) )
		);

		return this.historyTexture.sample( saturate( uvNode ) ).r.mul( edge );

	}

	/**
	 * Advance the history by one frame. Must run before the main scene render.
	 */
	update( renderer, camera, dt ) {

		const p = this.env.params;

		// Snap the window origin to whole texels. Without this the reprojection
		// resamples on a sub-texel offset every frame and the history smears into
		// mush within a couple of seconds.
		const texelSize = this.window / this.size;
		const ox = Math.round( camera.position.x / texelSize ) * texelSize;
		const oz = Math.round( camera.position.z / texelSize ) * texelSize;

		this.uPrevOrigin.value.copy( this.uOrigin.value );
		this.uOrigin.value.set( ox, oz );

		// Foam drifts downwind at roughly 3% of the wind speed.
		const drift = p.windSpeed * 0.03 * dt;
		this.uAdvect.value.set( this.env.windDirJS.x * drift, this.env.windDirJS.y * drift );

		// persistence 0 -> gone in a fraction of a second; 0.98 -> ~40 s memory.
		const lifetime = 0.20 + p.foamPersistence * p.foamPersistence * 42;
		this.uDecay.value = Math.exp( - dt / lifetime );

		this.uSourceGain.value = p.foamPersistence > 0 ? 1 : 0;

		const write = this.targets[ this.read ];
		const readTarget = this.targets[ 1 - this.read ];

		this.prevTexture.value = readTarget.texture;

		// First frame has no history to carry; make the reprojection a no-op so it
		// cannot sample uninitialised memory.
		if ( this._first ) {

			this.uPrevOrigin.value.copy( this.uOrigin.value );
			this.uAdvect.value.set( 0, 0 );
			this.uDecay.value = 0;
			this._first = false;

		}

		const previousTarget = renderer.getRenderTarget();
		renderer.setRenderTarget( write );
		renderer.render( this.scene, this.camera );
		renderer.setRenderTarget( previousTarget );

		this.historyTexture.value = write.texture;
		this.read = 1 - this.read;

	}

	reset() {

		this._first = true;

	}

	dispose() {

		for ( const t of this.targets ) t.dispose();
		this.quad.geometry.dispose();
		this.material.dispose();

	}

}
