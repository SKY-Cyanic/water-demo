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
	BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, DoubleSide, Mesh,
	MeshBasicNodeMaterial,
} from 'three/webgpu';
import {
	Fn, abs, attribute, cross, dot, faceDirection, float, floor, fract, max, min, mix,
	mx_fractal_noise_float, normalLocal, normalize, oneMinus, positionGeometry, saturate, sin,
	smoothstep, step, texture, varyingProperty, vec2, vec3, vec4,
} from 'three/tsl';

/* ------------------------------------------------------------------ shapes */

const LENGTH_AFT = 7.0;
const LENGTH_FWD = 8.0;
const BEAM = 4.4;
const DRAFT = 2.05;

/** How far the finished hull is dropped so she floats on her lines. */
const SINK = 1.35;

/**
 * Which piece of the boat a vertex belongs to.
 *
 * The fragment stage needs this because the surface detail is not the same
 * everywhere and cannot be inferred from the normal: planking runs fore-and-aft
 * on the topsides but athwartships on the deck, and a sail's panels run
 * horizontally regardless of which way it is facing.
 */
const PART = { hull: 0, deck: 2, cabin: 3, spar: 4, sail: 5, wire: 6 };

/** How far she may drift from the viewer before wrapping to the other side. */
const LATTICE = 900;

/** Half-beam at parametric station t, 0 = transom, 1 = stem. */
function halfBeam( t ) {

	// The exponent on t skews the maximum beam aft of midships, which is what
	// gives a hull a fine entry and a full run rather than a symmetric lozenge.
	return ( BEAM / 2 ) * Math.pow( Math.sin( Math.PI * Math.pow( t, 0.86 ) ), 0.62 );

}

/** Deck height above still water at station t. */
function sheer( t ) {

	const s = t * 2 - 1;
	return 1.85 + 0.85 * s * s + 0.25 * s * s * s;

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
		this.cvs = [];
		this.idx = [];

	}

	/** @param {number[]} colour linear RGB */
	add( geometry, colour, part = PART.hull ) {

		const base = this.pos.length / 3;
		const p = geometry.attributes.position.array;
		const n = geometry.attributes.normal.array;

		for ( let i = 0; i < p.length; i ++ ) this.pos.push( p[ i ] );
		for ( let i = 0; i < n.length; i ++ ) this.nrm.push( n[ i ] );
		for ( let i = 0; i < p.length / 3; i ++ ) {

			this.col.push( colour[ 0 ], colour[ 1 ], colour[ 2 ] );
			this.cvs.push( part );

		}

		const index = geometry.index.array;
		for ( let i = 0; i < index.length; i ++ ) this.idx.push( index[ i ] + base );

		geometry.dispose();

	}

	build() {

		const g = new BufferGeometry();
		g.setAttribute( 'position', new BufferAttribute( new Float32Array( this.pos ), 3 ) );
		g.setAttribute( 'normal', new BufferAttribute( new Float32Array( this.nrm ), 3 ) );
		g.setAttribute( 'paint', new BufferAttribute( new Float32Array( this.col ), 3 ) );
		g.setAttribute( 'part', new BufferAttribute( new Float32Array( this.cvs ), 1 ) );
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

	// The boot top is a *height*, a little above the waterline, so it has to be
	// solved per station rather than fixed at a section parameter. Splitting at a
	// constant |s| put it 1.2 m above the water amidships and painted the entire
	// topside dark — the boat looked like it was sinking.
	const BOOT_Y = 0.22;

	const bootAt = ( t ) => {

		const kd = keel( t );
		return Math.min( 0.97, Math.pow( Math.max( 0, ( BOOT_Y + SINK + kd ) / ( sheer( t ) + kd ) ), 1 / 1.75 ) );

	};

	// Bottom: keel up to the boot top.
	b.add( loft( 30, 18, ( t, v ) => section( t, ( v * 2 - 1 ) * bootAt( t ) ) ), [ 0.030, 0.048, 0.062 ], PART.hull );

	// Topsides: the two flanks above it.
	for ( const sign of [ - 1, 1 ] ) {

		b.add( loft( 30, 4, ( t, v ) => {

			const a = bootAt( t );
			return section( t, sign * ( a + v * ( 1 - a ) ) );

		} ), [ 0.55, 0.56, 0.54 ], PART.hull );

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

	} ), [ 0.30, 0.21, 0.125 ], PART.deck );

	// --- cabin
	const cabin = new BoxGeometry( 2.05, 0.95, 3.2 );
	cabin.translate( 0, sheer( 0.42 ) + 0.52, - 1.1 );
	b.add( cabin, [ 0.30, 0.30, 0.29 ], PART.cabin );

	const roof = new BoxGeometry( 2.25, 0.12, 3.4 );
	roof.translate( 0, sheer( 0.42 ) + 1.04, - 1.1 );
	b.add( roof, [ 0.20, 0.19, 0.185 ], PART.cabin );

	// --- mast, boom, bowsprit
	const deckY = sheer( 0.56 ) + 0.11;

	const mast = new CylinderGeometry( 0.085, 0.13, 11.4, 10 );
	mast.translate( 0, deckY + 5.7, 1.0 );
	b.add( mast, [ 0.42, 0.32, 0.20 ], PART.spar );

	const boom = new CylinderGeometry( 0.075, 0.085, 5.0, 8 );
	boom.rotateX( Math.PI / 2 );
	boom.translate( 0, deckY + 1.45, - 1.4 );
	b.add( boom, [ 0.42, 0.32, 0.20 ], PART.spar );

	const sprit = new CylinderGeometry( 0.05, 0.075, 2.8, 8 );
	sprit.rotateX( Math.PI / 2.32 );
	sprit.translate( 0, sheer( 0.985 ) - 0.15, LENGTH_FWD + 0.55 );
	b.add( sprit, [ 0.42, 0.32, 0.20 ], PART.spar );

	// --- standing rigging. Four wires, each a hair over a centimetre thick.
	//     They cost almost nothing and they are most of what separates a mast
	//     from a stick: a rig reads as tensioned or it reads as a pole.
	const masthead = [ 0, deckY + 11.2, 1.0 ];

	const strut = ( a, c, r ) => {

		const dx = c[ 0 ] - a[ 0 ], dy = c[ 1 ] - a[ 1 ], dz = c[ 2 ] - a[ 2 ];
		const len = Math.hypot( dx, dy, dz );
		const g = new CylinderGeometry( r, r, len, 5 );

		// The cylinder starts along +Y; rotate that onto the span, then translate
		// to its midpoint.
		const yaw = Math.atan2( dx, dz );
		const pitch = Math.atan2( Math.hypot( dx, dz ), dy );
		g.rotateX( pitch );
		g.rotateY( yaw );
		g.translate( ( a[ 0 ] + c[ 0 ] ) / 2, ( a[ 1 ] + c[ 1 ] ) / 2, ( a[ 2 ] + c[ 2 ] ) / 2 );
		return g;

	};

	const WIRE = [ 0.34, 0.33, 0.30 ];

	b.add( strut( masthead, [ 0, sheer( 0.985 ) + 0.15, LENGTH_FWD + 1.6 ], 0.028 ), WIRE, PART.wire );   // forestay
	b.add( strut( masthead, [ 0, sheer( 0.02 ) + 0.05, - LENGTH_AFT + 0.4 ], 0.026 ), WIRE, PART.wire );  // backstay
	b.add( strut( masthead, [ halfBeam( 0.5 ) * 0.94, sheer( 0.5 ), 0.2 ], 0.024 ), WIRE, PART.wire );    // shrouds
	b.add( strut( masthead, [ - halfBeam( 0.5 ) * 0.94, sheer( 0.5 ), 0.2 ], 0.024 ), WIRE, PART.wire );

	// --- mizzen. Making her a ketch is the cheapest large change available to
	//     the silhouette: a second, shorter mast aft breaks the single-triangle
	//     read that any sloop has from a distance, and it costs one spar, one
	//     boom and one sail.
	const mizZ = - 4.3;
	const mizHead = [ 0, deckY + 8.0, mizZ ];

	const mizzen = new CylinderGeometry( 0.065, 0.10, 8.2, 8 );
	mizzen.translate( 0, deckY + 4.1, mizZ );
	b.add( mizzen, [ 0.42, 0.32, 0.20 ], PART.spar );

	const mizBoom = new CylinderGeometry( 0.055, 0.065, 3.0, 8 );
	mizBoom.rotateX( Math.PI / 2 );
	mizBoom.translate( 0, deckY + 1.2, mizZ - 1.5 );
	b.add( mizBoom, [ 0.42, 0.32, 0.20 ], PART.spar );

	b.add( strut( mizHead, [ 0, sheer( 0.02 ) + 0.05, - LENGTH_AFT + 0.5 ], 0.022 ), WIRE, PART.wire );
	b.add( strut( mizHead, [ halfBeam( 0.28 ) * 0.92, sheer( 0.28 ), mizZ ], 0.020 ), WIRE, PART.wire );
	b.add( strut( mizHead, [ - halfBeam( 0.28 ) * 0.92, sheer( 0.28 ), mizZ ], 0.020 ), WIRE, PART.wire );

	b.add( loft( 8, 8, ( t, v ) => {

		const luffY = deckY + 1.2 + t * 6.6;
		const foot = mizZ - 3.0;
		const chord = ( 1 - t ) * foot + t * ( mizZ - 0.5 );
		const belly = Math.sin( Math.PI * v ) * Math.sin( Math.PI * t * 0.9 ) * 0.42;

		return [ belly, luffY - v * 0.22, mizZ + v * ( chord - mizZ ) ];

	} ), [ 0.78, 0.76, 0.70 ], PART.sail );

	// --- gaff: the spar along the head of the mainsail. It is what makes a rig
	//     read as working craft rather than as a modern triangle.
	b.add( strut(
		[ 0, deckY + 8.6, 1.0 ],
		[ 0, deckY + 10.6, - 1.9 ],
		0.06
	), [ 0.42, 0.32, 0.20 ], PART.spar );

	// --- rail: stanchions along the sheer with a wire run through them. Small,
	//     repeated, and everywhere the eye goes — which is exactly the kind of
	//     detail that separates a shape from a boat.
	const railTop = ( t ) => [
		halfBeam( t ) * 0.97, sheer( t ) + 0.60, zAt( t ),
	];

	for ( let i = 0; i <= 9; i ++ ) {

		const t = 0.10 + ( i / 9 ) * 0.80;
		const top = railTop( t );

		for ( const sign of [ 1, - 1 ] ) {

			b.add( strut(
				[ sign * halfBeam( t ) * 0.97, sheer( t ), zAt( t ) ],
				[ sign * top[ 0 ], top[ 1 ], top[ 2 ] ],
				0.026
			), [ 0.46, 0.46, 0.44 ], PART.wire );

			if ( i > 0 ) {

				const p = 0.10 + ( ( i - 1 ) / 9 ) * 0.80;
				const a = railTop( p );
				b.add( strut(
					[ sign * a[ 0 ], a[ 1 ], a[ 2 ] ],
					[ sign * top[ 0 ], top[ 1 ], top[ 2 ] ],
					0.018
				), [ 0.52, 0.52, 0.50 ], PART.wire );

			}

		}

	}

	// --- mainsail: a cambered quad from the mast to the boom end. The belly is
	//     the whole point; a flat sail reads as cardboard.
	b.add( loft( 10, 10, ( t, v ) => {

		const luffY = deckY + 1.45 + t * 9.4;          // up the mast
		const foot = - 1.4 - 2.5;                      // boom end, aft
		const chord = ( 1 - t ) * ( foot - 1.0 ) + t * ( - 0.4 );

		const z = 1.0 + v * ( chord - 1.0 );
		const belly = Math.sin( Math.PI * v ) * Math.sin( Math.PI * t * 0.9 ) * 0.62;

		return [ belly, luffY - v * 0.30, z ];

	} ), [ 0.80, 0.78, 0.72 ], PART.sail );

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

	} ), [ 0.78, 0.76, 0.71 ], PART.sail );

	const g = b.build();

	// Sink her. The boat samples the swell at one point but spans fifteen metres
	// of it, so the water beside the hull is routinely half a metre off what the
	// hull was placed against — and the error only reads as wrong when it exposes
	// the underbody. Sitting deeper puts the mismatch below the waterline, where
	// it is invisible, which is cheaper and steadier than any amount of extra
	// sampling.
	g.translate( 0, - SINK, 0 );
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
		env.u.vesselSpeed.value = 1;

		// Bow direction in world XZ. rotateY(h) maps the hull's +Z to this.
		this._bow = [ Math.sin( heading ), Math.cos( heading ) ];
		this._travel = 0;

		// QA holds her still so the fixed inspection views stay repeatable. The
		// wake uniform is untouched, so the shots still show it.
		this.hove = false;

	}

	_buildMaterial( spectral ) {

		const u = this.env.u;

		const material = new MeshBasicNodeMaterial();
		material.name = 'Vessel';
		// The sails are single sheets and the hull shell is open at the deck, so
		// backfaces are visible from ordinary viewpoints.
		material.side = DoubleSide;

		const vNormal = varyingProperty( 'vec3', 'vVesNormal' );
		const vPaint = varyingProperty( 'vec3', 'vVesPaint' );
		const vLocalY = varyingProperty( 'float', 'vVesLocalY' );
		const vPart = varyingProperty( 'float', 'vVesPart' );
		const vLocal = varyingProperty( 'vec3', 'vVesLocal' );

		material.positionNode = Fn( () => {

			// Live, because she sails. A baked constant would have pinned the hull
			// while the wake and the waterline foam — which read the uniform —
			// walked away from her.
			const anchor = u.vesselPos.xz.toVar( 'vesAnchor' );

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
				// Sample every cascade, not just the swell: the waterline has to match
				// the surface the eye sees, and the chop cascades are a third of a
				// metre of it. (The *rigid* placement above still uses cascade 0
				// alone — that is about how a hull responds, which is a different
				// question from where the water is.)
				const wxz = world.xz.toVar( 'vesWXZ' );
				const here = float( 0 ).toVar( 'vesWaterY' );

				for ( let c = 0; c < spectral.sizes.length; c ++ ) {

					here.addAssign( texture( spectral.disp[ c ], wxz.div( spectral.sizes[ c ] ), float( 0 ) ).y );

				}

				const sink = smoothstep( 0.80, - 0.05, p.y ).toVar( 'vesSink' );

				// Assigning through a swizzle — world.y.assign(...) — compiles without
				// complaint and does nothing. The hull kept its rigid height and hung
				// above the water exactly as before the conform was written.
				world.assign( vec3( world.x, mix( world.y, here.add( p.y ), sink ), world.z ) );

			}

			vNormal.assign( normalize(
				tangent.mul( normalLocal.x ).add( normal.mul( normalLocal.y ) ).add( bitangent.mul( normalLocal.z ) )
			) );
			vPaint.assign( attribute( 'paint', 'vec3' ) );
			vPart.assign( attribute( 'part', 'float' ) );
			vLocal.assign( p );
			vLocalY.assign( p.y );

			return world;

		} )();

		material.colorNode = Fn( () => {

			// Sails and the thin parts of the rig are single-sided sheets, so the
			// normal is only right for one of the two faces. Taking the side facing
			// the eye, rather than the one the winding order happens to give, is
			// what stops a sail from going black the moment you walk around it.
			const n = normalize( vNormal ).mul( faceDirection ).toVar( 'vesNorm' );

			const paint = vPaint.toVar( 'vesPaint' );

			/* --- surface detail ------------------------------------------ */

			// Local coordinates, with the waterline at y = 0 — the sink is baked
			// into the geometry, so this is directly usable as "height above the
			// water" for the wear band below.
			const L = vLocal.toVar( 'vesLocal' );
			const part = vPart.toVar( 'vesPartId' );

			const isSail = step( 4.5, part ).mul( step( part, float( 5.5 ) ) ).toVar( 'isSail' );
			const isDeck = step( 1.5, part ).mul( step( part, float( 2.5 ) ) ).toVar( 'isDeck' );
			const isHull = step( part, float( 0.5 ) ).toVar( 'isHull' );

			// A seam is a groove, so it reads as a thin dark line plus a lighter
			// edge where the plank above it catches the light. `axis` selects which
			// way the boards run: fore-and-aft on the topsides, athwartships on the
			// deck. Getting that backwards is instantly wrong to anyone who has
			// looked at a boat, and it is not something a normal can tell you.
			const seamAt = ( axis, pitch, width ) => {

				const f = fract( axis.mul( pitch ) ).toVar();
				const d = min( f, oneMinus( f ) ).toVar();
				return oneMinus( smoothstep( 0.0, width, d ) );

			};

			// Per-board tone. Timber is not uniform, and a hull with identical
			// planks reads as extruded plastic however good the lighting is.
			const boardTone = ( axis, pitch ) => {

				const idx = floor( axis.mul( pitch ) );
				return fract( sin( idx.mul( 91.37 ) ).mul( 4173.11 ) ).sub( 0.5 );

			};

			const detail = float( 1.0 ).toVar( 'vesDetail' );

			// Hull: boards run fore-and-aft, so they band in height. ~22 cm.
			const hullSeam = seamAt( L.y, 4.5, 0.055 ).mul( isHull );
			detail.mulAssign( oneMinus( hullSeam.mul( 0.42 ) ) );
			detail.addAssign( boardTone( L.y, 4.5 ).mul( 0.075 ).mul( isHull ) );

			// Deck: boards run fore-and-aft too, so they band across the beam.
			const deckSeam = seamAt( L.x, 3.4, 0.070 ).mul( isDeck );
			detail.mulAssign( oneMinus( deckSeam.mul( 0.50 ) ) );
			detail.addAssign( boardTone( L.x, 3.4 ).mul( 0.10 ).mul( isDeck ) );

			// Paint that has spent its life at the waterline. A boot stripe is the
			// dirtiest part of any hull, and the band of staining just above it is
			// most of what separates a working boat from a render of one.
			const grime = mx_fractal_noise_float( vec3( L.xz.mul( 1.6 ), L.y.mul( 2.2 ) ), 3, 2.0, 0.55 )
				.mul( 0.5 ).add( 0.5 ).toVar( 'vesGrime' );
			const band = oneMinus( smoothstep( 0.0, 0.55, abs( L.y.sub( 0.10 ) ) ) ).toVar( 'vesBand' );
			detail.mulAssign( oneMinus( band.mul( grime ).mul( 0.34 ).mul( isHull ) ) );

			// Sailcloth: panels seamed horizontally, ~1.5 m, plus a slack wrinkle
			// field that is strongest near the luff where the cloth is gathered.
			const panel = seamAt( L.y, 0.66, 0.030 ).mul( isSail );
			detail.mulAssign( oneMinus( panel.mul( 0.16 ) ) );

			const wrinkle = mx_fractal_noise_float( vec3( L.xz.mul( 0.9 ), L.y.mul( 0.35 ) ), 3, 2.0, 0.5 );
			detail.addAssign( wrinkle.mul( 0.085 ).mul( isSail ) );

			// Spars: a little grain, so varnished wood is not a plastic tube.
			const spar = step( 3.5, part ).mul( step( part, float( 4.5 ) ) );
			detail.addAssign( boardTone( L.y.add( L.z ), 7.0 ).mul( 0.10 ).mul( spar ) );

			paint.mulAssign( max( detail, float( 0.35 ) ) );

			// Anything below the waterline is seen through the water column.
			const submerged = smoothstep( 0.10, - 0.55, vLocalY ).toVar( 'vesSub' );
			paint.assign( mix( paint, paint.mul( u.waterShallow ).mul( 1.9 ), submerged ) );

			const skyLight = mix( u.skyHorizon, u.skyZenith, 0.42 ).toVar( 'vesSky' );

			// Direct sun, hard. The previous version wrapped this into a broad
			// ambient and then added an unmodulated sky-coloured rim on top, which
			// meant every surface — hull, deck, sail, cabin — converged on the same
			// mid grey-blue and the boat rendered as a flat cut-out. Contrast
			// between faces is the entire read of a shape this simple.
			// Half-Lambert. A terminator that reaches zero turns any face pointing
			// away from a 34-degree sun into a black hole — the deck did exactly
			// that — and it makes the shading hostage to whether each lofted patch
			// happened to come out wound the right way.
			const sun = saturate( dot( n, u.sunDir ).mul( 0.5 ).add( 0.5 ) ).toVar( 'vesSun' );
			const sunSq = sun.mul( sun ).toVar( 'vesSunSq' );

			// Hemisphere ambient: sky from above, water bounce from below. This is
			// the term that keeps the shaded side from going black, and because it
			// varies with the normal it still describes the form.
			const hemi = mix(
				u.waterShallow.mul( 0.55 ),
				skyLight,
				saturate( n.y.mul( 0.5 ).add( 0.5 ) )
			).mul( u.sunIntensity.mul( 0.35 ).add( 0.30 ) ).toVar( 'vesHemi' );

			const lit = paint.mul(
				u.sunColor.mul( sunSq.mul( u.sunIntensity ).mul( 1.30 ) ).add( hemi )
			).toVar( 'vesLit' );

			// Sails are thin and translucent: backlit, they glow rather than fall
			// into silhouette. Without this the leeward side of every sail is a flat
			// dark shape, which is the single most obvious way canvas reads as sheet
			// metal.
			const through = saturate( dot( n.negate(), u.sunDir ) ).mul( isSail );
			lit.addAssign( paint.mul( u.sunColor ).mul( through.mul( u.sunIntensity ).mul( 0.85 ) ) );

			return vec4( max( lit, vec3( 0.0 ) ), 1.0 );

		} )();

		return material;

	}

	/**
	 * Make way.
	 *
	 * A wake needs a cause. Rather than paint a trail behind a moored boat, she
	 * makes about three knots along her heading — slow enough that the one-point
	 * wave sampling still looks settled, fast enough that the Kelvin arms have
	 * something to be the wake *of*.
	 *
	 * She wraps on a long lattice relative to the viewer, like the buoys, so she
	 * can sail indefinitely without ever sailing out of the world. The wrap is
	 * several hundred metres out, where haze has taken the contrast anyway.
	 */
	update( camera, dt ) {

		if ( ! this.hove ) this._travel += dt * 1.55;

		const bx = this.anchor[ 0 ] + this._bow[ 0 ] * this._travel;
		const bz = this.anchor[ 1 ] + this._bow[ 1 ] * this._travel;

		const x = bx + Math.round( ( camera.position.x - bx ) / LATTICE ) * LATTICE;
		const z = bz + Math.round( ( camera.position.z - bz ) / LATTICE ) * LATTICE;

		this.env.u.vesselPos.value.set( x, 0, z );

	}

	dispose() {

		this.mesh.geometry.dispose();
		this.material.dispose();

	}

}
