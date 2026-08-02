// Wake as a solved height field.
//
// Until now the wake existed only in the foam history: a Kelvin figure drawn at
// the right angle, deposited as foam, and completely absent from the geometry.
// The water did not move. A hull sat on a flat mean level with a picture of a
// wake painted behind it, and nothing else in the scene could feel it.
//
// This is a real field instead. A damped wave equation on a grid that follows
// the camera, into which floating objects inject their own displacement. What
// comes out is a surface that is genuinely deformed: the hull sits in the trough
// it pushes, the disturbance spreads and decays on its own, two objects' wakes
// interfere because they are the same field, and anything that samples the
// height gets the wake for free.
//
// What this cannot do, stated plainly. A non-dispersive wave equation propagates
// every wavelength at the same speed c, so a moving source produces a Mach cone
// at asin(c/v) — an angle that changes with speed. The Kelvin angle is 19.47
// degrees for *any* displacement hull at *any* speed, and it is constant
// precisely because deep-water waves are dispersive: omega = sqrt(gk), and the
// stationary-phase construction over that relation is what fixes the angle.
// A single-speed field cannot reproduce it, and tuning c to hit 19.47 at one
// speed only moves the error to every other speed.
//
// So the two are kept apart, each doing what it can: this field carries the
// disturbance — the trough, the spread, the interaction, the decay — and the
// analytic arms in the foam history keep the constant angle. Pretending the
// field alone gets the Kelvin pattern would be the wrong claim to make in a
// comment and a worse one to make in a screenshot.

import { HalfFloatType, Mesh, MeshBasicNodeMaterial, NearestFilter, OrthographicCamera, PlaneGeometry, RGBAFormat, RenderTarget, Scene, Vector2, Vector4 } from 'three/webgpu';
import { Fn, clamp, float, length, min, mix, oneMinus, saturate, smoothstep, step, texture, uniform, uv, vec2, vec4 } from 'three/tsl';

/** Objects that may inject in one frame. */
export const MAX_GENERATORS = 4;

export const WAKE_TIERS = {
	low: null,
	medium: { size: 256, world: 700 },
	high: { size: 512, world: 700 },
	ultra: { size: 512, world: 560 },
};

export class WakeField {

	constructor( env, tier ) {

		this.env = env;
		this.size = tier.size;
		this.world = tier.world;

		const options = {
			format: RGBAFormat,
			type: HalfFloatType,
			depthBuffer: false,
			stencilBuffer: false,
			// Nearest, deliberately. The solver reads its own neighbours by texel;
			// a bilinear tap between them is a low-pass filter inside the stencil
			// and it damps the field far faster than the friction term intends.
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			generateMipmaps: false,
		};

		this.targets = [
			new RenderTarget( tier.size, tier.size, options ),
			new RenderTarget( tier.size, tier.size, options ),
		];

		for ( const t of this.targets ) t.texture.name = 'WakeField';

		this.read = 0;
		this._first = true;

		this.uOrigin = uniform( new Vector2() );
		this.uPrevOrigin = uniform( new Vector2() );
		this.uWorld = uniform( this.world );
		this.uTexel = uniform( this.world / this.size );
		this.uDt = uniform( 1 / 60 );
		this.uDamping = uniform( 0.997 );
		this.uSpeed = uniform( 9.0 );          // metres per second of propagation

		// (x, z, radius, depth). depth 0 means inactive, so one uniform covers both.
		this.uGen = [];
		for ( let i = 0; i < MAX_GENERATORS; i ++ ) this.uGen.push( uniform( new Vector4() ) );

		this.fieldTexture = texture( this.targets[ 0 ].texture );
		this.fieldTexture.generateMipmaps = false;

		this.prevTexture = texture( this.targets[ 1 ].texture );
		this.prevTexture.generateMipmaps = false;

		this._buildPass();

	}

	_buildPass() {

		const material = new MeshBasicNodeMaterial();
		material.name = 'WakeSolve';
		material.depthTest = false;
		material.depthWrite = false;

		material.colorNode = Fn( () => {

			const texel = uv().toVar( 'wakeUV' );
			const worldXZ = texel.sub( 0.5 ).mul( this.uWorld ).add( this.uOrigin ).toVar( 'wakeWorld' );

			// Where this world position sat in last frame's window.
			const prevUV = worldXZ.sub( this.uPrevOrigin ).div( this.uWorld ).add( 0.5 ).toVar( 'wakePrevUV' );

			const inside = step( 0.0, prevUV.x ).mul( step( prevUV.x, 1.0 ) )
				.mul( step( 0.0, prevUV.y ) ).mul( step( prevUV.y, 1.0 ) );

			// A plain JS number, not a node. `- d` on a TSL node is JavaScript's
			// unary minus applied to an object: it yields NaN, silently, and the
			// NaN survives all the way into the generated WGSL as the literal
			// `NaN.0`, where it finally fails as a syntax error a hundred lines
			// from its cause. The grid step is known at build time anyway.
			const d = 1 / this.size;

			// Five-point Laplacian, read in the *previous* window so the whole
			// stencil is consistent with the sample at the centre. Reading the
			// neighbours in this frame's window while the centre came from last
			// frame's is a shear across the stencil, and it shows up as a
			// directional smear whenever the camera moves.
			const at = ( o ) => this.prevTexture.sample( prevUV.add( o ) ).mul( inside );

			const c = at( vec2( 0, 0 ) ).toVar( 'wakeC' );
			const lap = at( vec2( d, 0 ) ).x
				.add( at( vec2( - d, 0 ) ).x )
				.add( at( vec2( 0, d ) ).x )
				.add( at( vec2( 0, - d ) ).x )
				.sub( c.x.mul( 4.0 ) )
				.div( this.uTexel.mul( this.uTexel ) )
				.toVar( 'wakeLap' );

			// h(t+1) = 2h(t) - h(t-1) + c^2 dt^2 * laplacian, then damped.
			const speed2 = this.uSpeed.mul( this.uSpeed );
			const h = c.x.mul( 2.0 ).sub( c.y )
				.add( lap.mul( speed2 ).mul( this.uDt ).mul( this.uDt ) )
				.mul( this.uDamping )
				.toVar( 'wakeH' );

			// Hull injection. A floating body does not *add* to the field, it holds
			// the surface down where it is: the water inside the footprint is
			// displaced, and everything outside is the field's response to that.
			// Written as a soft Dirichlet condition rather than an impulse, which
			// also keeps it stable — an impulse proportional to speed blows up the
			// moment the frame rate drops.
			for ( let i = 0; i < MAX_GENERATORS; i ++ ) {

				const g = this.uGen[ i ];
				const r = length( worldXZ.sub( g.xy ) ).toVar( `wakeR${ i }` );
				const foot = oneMinus( smoothstep( g.z.mul( 0.45 ), g.z, r ) )
					.mul( step( 0.001, g.w ) )
					.toVar( `wakeFoot${ i }` );

				// Pulled toward the hull's own draught, not pushed by an impulse.
				// Partial rather than absolute, so the boundary stays soft and the
				// solver keeps some of its own state under the hull instead of
				// having it overwritten every step.
				h.assign( mix( h, g.w.negate(), foot.mul( 0.6 ) ) );

			}

			// Clamped. Half-float has range to spare, but a solver that has gone
			// unstable should produce a flat sea rather than an infinity that
			// propagates into the displacement and takes the whole mesh with it.
			const clamped = clamp( h, float( - 4.0 ), float( 4.0 ) ).toVar( 'wakeOut' );

			return vec4( clamped, c.x, 0.0, 1.0 );

		} )();

		this.material = material;
		this.scene = new Scene();
		this.camera = new OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );
		this.quad = new Mesh( new PlaneGeometry( 2, 2 ), material );
		this.quad.frustumCulled = false;
		this.scene.add( this.quad );

	}

	/** Surface height from the wake at a world XZ, as a node. */
	sample( worldXZ ) {

		const uvNode = worldXZ.sub( this.uOrigin ).div( this.uWorld ).add( 0.5 ).toVar( 'wakeSampleUV' );

		// Fade at the window edge so the field does not end in a step.
		const edge = min(
			min( smoothstep( 0.0, 0.05, uvNode.x ), smoothstep( 1.0, 0.95, uvNode.x ) ),
			min( smoothstep( 0.0, 0.05, uvNode.y ), smoothstep( 1.0, 0.95, uvNode.y ) )
		);

		return this.fieldTexture.sample( saturate( uvNode ), float( 0 ) ).x.mul( edge );

	}

	/**
	 * Advance one step.
	 *
	 * @param {Array} generators  [{ x, z, radius, depth }]
	 */
	update( renderer, camera, dt, generators = [] ) {

		// Snap the window to whole texels, for the same reason the foam history
		// does: an unsnapped origin resamples the whole field on a sub-texel offset
		// every frame, and a wave equation fed its own blurred output loses its
		// waves within a couple of seconds.
		const texel = this.world / this.size;
		const ox = Math.round( camera.position.x / texel ) * texel;
		const oz = Math.round( camera.position.z / texel ) * texel;

		this.uPrevOrigin.value.copy( this.uOrigin.value );
		this.uOrigin.value.set( ox, oz );

		// Fixed step. The Courant condition is on dt, so a long frame must not be
		// allowed to integrate a long step — it is better to run the simulation
		// slightly slow than to have it explode.
		this.uDt.value = Math.min( dt, 1 / 50 );

		for ( let i = 0; i < MAX_GENERATORS; i ++ ) {

			const g = generators[ i ];
			if ( g ) this.uGen[ i ].value.set( g.x, g.z, g.radius, g.depth );
			else this.uGen[ i ].value.set( 0, 0, 1, 0 );

		}

		const write = this.targets[ this.read ];
		const readTarget = this.targets[ 1 - this.read ];

		this.prevTexture.value = readTarget.texture;

		if ( this._first ) {

			this.uPrevOrigin.value.copy( this.uOrigin.value );
			this._first = false;

		}

		const previous = renderer.getRenderTarget();
		renderer.setRenderTarget( write );
		renderer.render( this.scene, this.camera );
		renderer.setRenderTarget( previous );

		this.fieldTexture.value = write.texture;
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
