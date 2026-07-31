// The hero object: a small gaff-rigged sailing boat.
//
// A sea with nothing on it is a texture. Buoys give it scale, but they give it
// no *contact* — nothing displaces the water, nothing casts a shadow into it,
// nothing has a waterline. Almost everything that reads as "this is a real body
// of water" in a good ocean shot comes from the boundary between the water and
// something floating in it, and that boundary is what this file exists for.
//
// Everything is generated: the hull is lofted from parametric stations, the
// rig from cylinders, the sails from cambered grids. No models, no textures —
// the same rule the rest of the demo follows. It is deliberately a small
// working boat rather than a square-rigger: a simple silhouette drawn well
// beats a complicated one drawn from primitives.
//
// Floating, like the buoys, is done in the vertex shader with no readback and
// no physics — but with one difference that matters. A buoy is a point and
// rides everything; a fifteen-metre hull integrates over its own length and
// physically cannot follow a three-metre wave. So the vessel samples only the
// longest cascade and damps the slope it reads there. That single change is
// the difference between a boat and a cork.

import {
	BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, Mesh,
	MeshBasicNodeMaterial,
} from 'three/webgpu';
import {
	Fn, attribute, cameraPosition, cross, dot, float, max, mix, normalLocal, normalize,
	positionGeometry, pow, saturate, smoothstep, texture, varyingProperty, vec2, vec3, vec4,
} from 'three/tsl';

/* ------------------------------------------------------------------ shapes */

const LENGTH_AFT = 7.0;
const LENGTH_FWD = 8.0;
const BEAM = 4.4;
const DRAFT = 2.05;

/** Half-beam at parametric station t, 0 = transom, 1 = stem. */
function halfBeam( t ) {

	// The exponent on t skews the maximum beam aft of midships, which is what
	// gives a hull a fine entry and a full run rather than a symmetric lozenge.
	return ( BEAM / 2 ) * Math.pow( Math.sin( Math.PI * Math.pow( t, 0.86 ) ), 0.62 );

}

/** Deck height above still water at station t. */
function sheer( t ) {

	const s = t * 2 - 1;
	return 1.02 + 0.62 * s * s + 0.18 * s * s * s;

}

/** Keel depth below still water at station t. */
function keel( t ) {

	return DRAFT * Math.pow( Math.sin( Math.PI * t ), 0.45 );

}

/**
 * Accumulates geometries into one interleaved buffer.
 *
 * One draw call and one vertex program for the whole boat. That is not just
 * tidiness: every part has to be displaced by the same wave sample and tilted
 * by the same basis, and splitting it across materials would mean computing
 * that sample several times and trusting the results to agree.
 */
class Builder {

	constructor() {

		this.pos = [];
		this.nrm = [];
		this.col = [];
		this.idx = [];

	}

	/** @param {number[]} colour linear RGB */
	add( geometry, colour ) {

		const base = this.pos.length / 3;
		const p = geometry.attributes.position.array;
		const n = geometry.attributes.normal.array;

		for ( let i = 0; i < p.length; i ++ ) this.pos.push( p[ i ] );
		for ( let i = 0; i < n.length; i ++ ) this.nrm.push( n[ i ] );
		for ( let i = 0; i < p.length / 3; i ++ ) this.col.push( colour[ 0 ], colour[ 1 ], colour[ 2 ] );

		const index = geometry.index.array;
		for ( let i = 0; i < index.length; i ++ ) this.idx.push( index[ i ] + base );

		geometry.dispose();

	}

	build() {

		const g = new BufferGeometry();
		g.setAttribute( 'position', new BufferAttribute( new Float32Array( this.pos ), 3 ) );
		g.setAttribute( 'normal', new BufferAttribute( new Float32Array( this.nrm ), 3 ) );
		g.setAttribute( 'paint', new BufferAttribute( new Float32Array( this.col ), 3 ) );
		g.setIndex( this.idx );
		return g;

	}

}

/** Loft a surface from a (station, section) -> position function. */
function loft( ns, nv, fn ) {

	const pos = [];
	const idx = [];

	for ( let i = 0; i <= ns; i ++ ) {

		for ( let j = 0; j <= nv; j ++ ) {

			const p = fn( i / ns, j / nv );
			pos.push( p[ 0 ], p[ 1 ], p[ 2 ] );

		}

	}

	const row = nv + 1;

	for ( let i = 0; i < ns; i ++ ) {

		for ( let j = 0; j < nv; j ++ ) {

			const a = i * row + j;
			idx.push( a, a + 1, a + row, a + 1, a + row + 1, a + row );

		}

	}

	const g = new BufferGeometry();
	g.setAttribute( 'position', new BufferAttribute( new Float32Array( pos ), 3 ) );
	g.setIndex( idx );
	g.computeVertexNormals();
	return g;

}

function buildGeometry() {

	const b = new Builder();

	const zAt = ( t ) => - LENGTH_AFT + t * ( LENGTH_AFT + LENGTH_FWD );

	// --- hull shell: port sheer, down around the keel, up to starboard sheer.
	//     Split at the boot top so the topsides can be painted a different colour
	//     from the bottom. A single-colour hull reads as an extrusion; the band is
	//     most of what says "boat".
	const section = ( t, s ) => {

		const a = Math.abs( s );
		const kd = keel( t );

		return [
			halfBeam( t ) * Math.sign( s ) * Math.pow( a, 0.60 ),
			- kd + ( sheer( t ) + kd ) * Math.pow( a, 1.75 ),
			zAt( t ),
		];

	};

	// Bottom: |s| in [0, BOOT].
	const BOOT = 0.90;

	b.add( loft( 30, 18, ( t, v ) => section( t, ( v * 2 - 1 ) * BOOT ) ), [ 0.045, 0.070, 0.080 ] );

	// Topsides: the two flanks above the boot top, port and starboard.
	for ( const sign of [ - 1, 1 ] ) {

		b.add( loft( 30, 3, ( t, v ) => section( t, sign * ( BOOT + v * ( 1 - BOOT ) ) ) ),
			[ 0.68, 0.66, 0.60 ] );

	}

	// --- deck, with a little camber so it is not a flat lid
	b.add( loft( 30, 8, ( t, v ) => {

		const s = v * 2 - 1;
		const a = Math.abs( s );
		return [
			halfBeam( t ) * s * 0.985,
			sheer( t ) + 0.11 * ( 1 - a * a ),
			zAt( t ),
		];

	} ), [ 0.30, 0.21, 0.125 ] );

	// --- cabin
	const cabin = new BoxGeometry( 2.5, 1.15, 3.6 );
	cabin.translate( 0, sheer( 0.42 ) + 0.62, - 1.1 );
	b.add( cabin, [ 0.52, 0.50, 0.47 ] );

	const roof = new BoxGeometry( 2.7, 0.14, 3.8 );
	roof.translate( 0, sheer( 0.42 ) + 1.24, - 1.1 );
	b.add( roof, [ 0.20, 0.19, 0.185 ] );

	// --- mast, boom, bowsprit
	const deckY = sheer( 0.56 ) + 0.11;

	const mast = new CylinderGeometry( 0.085, 0.13, 11.4, 10 );
	mast.translate( 0, deckY + 5.7, 1.0 );
	b.add( mast, [ 0.42, 0.32, 0.20 ] );

	const boom = new CylinderGeometry( 0.075, 0.085, 5.0, 8 );
	boom.rotateX( Math.PI / 2 );
	boom.translate( 0, deckY + 1.45, - 1.4 );
	b.add( boom, [ 0.42, 0.32, 0.20 ] );

	const sprit = new CylinderGeometry( 0.055, 0.085, 3.4, 8 );
	sprit.rotateX( Math.PI / 2.32 );
	sprit.translate( 0, sheer( 1 ) + 0.55, LENGTH_FWD + 1.15 );
	b.add( sprit, [ 0.42, 0.32, 0.20 ] );

	// --- mainsail: a cambered quad from the mast to the boom end. The belly is
	//     the whole point; a flat sail reads as cardboard.
	b.add( loft( 10, 10, ( t, v ) => {

		const luffY = deckY + 1.45 + t * 9.4;          // up the mast
		const foot = - 1.4 - 2.5;                      // boom end, aft
		const chord = ( 1 - t ) * ( foot - 1.0 ) + t * ( - 0.4 );

		const z = 1.0 + v * ( chord - 1.0 );
		const belly = Math.sin( Math.PI * v ) * Math.sin( Math.PI * t * 0.9 ) * 0.62;

		return [ belly, luffY - v * 0.30, z ];

	} ), [ 0.80, 0.78, 0.72 ] );

	// --- jib
	b.add( loft( 8, 8, ( t, v ) => {

		const head = [ 0, deckY + 10.2, 1.0 ];
		const tack = [ 0, sheer( 1 ) + 1.35, LENGTH_FWD + 2.5 ];
		const clew = [ 0, deckY + 1.5, 2.2 ];

		// Interpolate the leading edge (head->tack) toward the clew.
		const lx = head[ 0 ] + ( tack[ 0 ] - head[ 0 ] ) * t;
		const ly = head[ 1 ] + ( tack[ 1 ] - head[ 1 ] ) * t;
		const lz = head[ 2 ] + ( tack[ 2 ] - head[ 2 ] ) * t;

		const belly = Math.sin( Math.PI * v ) * Math.sin( Math.PI * t ) * 0.48;

		return [
			lx + belly,
			ly + ( clew[ 1 ] - ly ) * v,
			lz + ( clew[ 2 ] - lz ) * v,
		];

	} ), [ 0.78, 0.76, 0.71 ] );

	const g = b.build();

	// Sink her. The boat samples the swell at one point but spans fifteen metres
	// of it, so the water beside the hull is routinely half a metre off what the
	// hull was placed against — and the error only reads as wrong when it exposes
	// the underbody. Sitting deeper puts the mismatch below the waterline, where
	// it is invisible, which is cheaper and steadier than any amount of extra
	// sampling.
	g.translate( 0, - 0.55, 0 );
	return g;

}

/* ----------------------------------------------------------------- vessel */

export class Vessel {

	/**
	 * @param {object} env
	 * @param {object|null} spectral cascade textures, when the spectral engine is up
	 * @param {object} opts
	 * @param {number[]} opts.anchor  world XZ the boat is moored at
	 * @param {number} opts.heading   radians
	 */
	constructor( env, spectral, { anchor = [ 11, 17 ], heading = - 1.0 } = {} ) {

		this.env = env;
		this.anchor = anchor;
		this.heading = heading;

		const geometry = buildGeometry();

		// Bake the heading in. The hull never turns, so rotating on the CPU once
		// keeps the vertex program to a single basis transform — and lets the
		// water's contact terms use one world-space ellipse instead of a rotation.
		geometry.rotateY( heading );
		geometry.computeVertexNormals();

		this.material = this._buildMaterial( spectral );

		this.mesh = new Mesh( geometry, this.material );
		this.mesh.name = 'Vessel';
		this.mesh.frustumCulled = false;
		this.mesh.matrixAutoUpdate = false;

		// Where the water shader should put the waterline foam and hull shadow.
		// The half-extents are the hull's, not the rig's — a mast twelve metres up
		// does not have a waterline.
		env.u.vesselPos.value.set( anchor[ 0 ], 0, anchor[ 1 ] );
		env.u.vesselHalf.value.set( BEAM / 2 - 0.05, ( LENGTH_AFT + LENGTH_FWD ) / 2 - 0.6 );
		env.u.vesselDir.value.set( Math.cos( heading ), Math.sin( heading ) );

	}

	_buildMaterial( spectral ) {

		const u = this.env.u;

		const material = new MeshBasicNodeMaterial();
		material.name = 'Vessel';

		const vNormal = varyingProperty( 'vec3', 'vVesNormal' );
		const vPaint = varyingProperty( 'vec3', 'vVesPaint' );
		const vLocalY = varyingProperty( 'float', 'vVesLocalY' );
		const vWorld = varyingProperty( 'vec3', 'vVesWorld' );

		material.positionNode = Fn( () => {

			const anchor = vec2( this.anchor[ 0 ], this.anchor[ 1 ] );

			const disp = vec3( 0, 0, 0 ).toVar( 'vesDisp' );
			const slope = vec2( 0, 0 ).toVar( 'vesSlope' );

			if ( spectral ) {

				// Longest cascade only. A hull fifteen metres long averages over
				// everything shorter than itself; feeding it the chop cascades makes
				// it twitch like a cork, which is the single most common way a
				// floating object in a demo gives itself away.
				const uvw = anchor.div( spectral.sizes[ 0 ] );
				disp.assign( texture( spectral.disp[ 0 ], uvw, float( 0 ) ).xyz );
				slope.assign( texture( spectral.slope[ 0 ], uvw, float( 0 ) ).xy.mul( 0.55 ) );

			}

			const normal = normalize( vec3( slope.x.negate(), 1.0, slope.y.negate() ) ).toVar( 'vesN' );

			const ref = vec3( 0.0, 0.0, 1.0 );
			const tangent = normalize( cross( ref, normal ) ).toVar( 'vesT' );
			const bitangent = cross( normal, tangent ).toVar( 'vesB' );

			const p = positionGeometry;
			const tilted = tangent.mul( p.x ).add( normal.mul( p.y ) ).add( bitangent.mul( p.z ) );

			const world = vec3( anchor.x, 0.0, anchor.y ).add( disp ).add( tilted ).toVar( 'vesWorld' );

			if ( spectral ) {

				// Soft hull.
				//
				// A rigid body placed against a single wave sample is wrong along its
				// own length: the swell under the bow is routinely half a metre from
				// the swell under the stern, and the error shows up as daylight under
				// the planking — the one artefact that instantly reads as "pasted on".
				//
				// So the submerged part of the hull is pulled onto the water height at
				// *its own* position, fading out at the sheer. The topsides, deck and
				// rig stay rigid, which is what carries the boat's pitch and roll. It
				// bends the hull by a few centimetres in exchange for a waterline that
				// is correct everywhere, and the bend is under water.
				const here = texture( spectral.disp[ 0 ], world.xz.div( spectral.sizes[ 0 ] ), float( 0 ) ).y;
				const sink = smoothstep( 0.80, - 0.05, p.y ).toVar( 'vesSink' );
				world.y.assign( mix( world.y, here.add( p.y ), sink ) );

			}

			vNormal.assign( normalize(
				tangent.mul( normalLocal.x ).add( normal.mul( normalLocal.y ) ).add( bitangent.mul( normalLocal.z ) )
			) );
			vPaint.assign( attribute( 'paint', 'vec3' ) );
			vLocalY.assign( p.y );
			vWorld.assign( world );

			return world;

		} )();

		material.colorNode = Fn( () => {

			const n = normalize( vNormal ).toVar( 'vesNorm' );
			const nDotL = saturate( dot( n, u.sunDir ) ).toVar( 'vesNdL' );

			const skyLight = mix( u.skyHorizon, u.skyZenith, 0.42 ).toVar( 'vesSky' );
			const ambient = u.sunIntensity.mul( 0.50 ).add( 0.40 ).toVar( 'vesAmb' );

			const paint = vPaint.toVar( 'vesPaint' );

			// Anything below the waterline is seen through the water column, so it
			// takes the water's colour rather than its own.
			const submerged = smoothstep( 0.10, - 0.45, vLocalY ).toVar( 'vesSub' );
			paint.assign( mix( paint, paint.mul( u.waterShallow ).mul( 2.0 ), submerged ) );

			// A hull sits in a bowl of reflected light. Skylight from above, plus a
			// weaker bounce from the water below, which is what stops the underside
			// of the sheer and the boom from going flat black.
			const up = saturate( n.y ).toVar( 'vesUp' );
			const down = saturate( n.y.negate() ).toVar( 'vesDown' );

			const V = normalize( cameraPosition.sub( vWorld ) ).toVar( 'vesV' );
			const rim = pow( saturate( float( 1 ).sub( saturate( dot( n, V ) ) ) ), 3.0 ).mul( 0.30 );

			const lit = paint.mul(
				u.sunColor.mul( nDotL.mul( u.sunIntensity ).mul( 1.05 ) )
					.add( skyLight.mul( ambient.mul( 0.55 ).mul( up.mul( 0.7 ).add( 0.3 ) ) ) )
					.add( u.waterShallow.mul( ambient.mul( 0.30 ).mul( down ) ) )
			).add( skyLight.mul( rim ) );

			return vec4( max( lit, vec3( 0.0 ) ), 1.0 );

		} )();

		return material;

	}

	dispose() {

		this.mesh.geometry.dispose();
		this.material.dispose();

	}

}
