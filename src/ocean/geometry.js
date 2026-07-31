// Camera-centred radial ocean mesh.
//
// Why radial rather than a clipmap or a projected grid:
//
//   * It is ONE continuous mesh. There are no LOD seams to crack, no stitching
//     strips, no T-junctions — the entire class of "hairline gaps appear when
//     the camera moves" bugs simply cannot occur.
//   * Ring radii grow geometrically, so vertex spacing scales with distance.
//     Detail lands where it is visible and nowhere else.
//   * Angular spacing is 2*pi*r/S and radial spacing is ~r*growth, so triangle
//     aspect ratio stays near-constant from 0.3 m out to 60 km instead of
//     degenerating into slivers.
//   * The rim sits far past the horizon and is buried in haze, so the mesh
//     boundary is never visible.
//
// The mesh is re-centred on the camera every frame; wave phase is sampled from
// world XZ, so the water does not slide along with the viewer.

import { BufferAttribute, BufferGeometry, Sphere, Vector3 } from 'three/webgpu';

export const GEOMETRY_TIERS = {
	low: { rings: 176, sectors: 224, minSpacing: 0.55 },
	medium: { rings: 256, sectors: 320, minSpacing: 0.42 },
	high: { rings: 384, sectors: 448, minSpacing: 0.30 },
	ultra: { rings: 512, sectors: 576, minSpacing: 0.24 },
};

/** Rim distance. Well past the horizon for any altitude the camera can reach. */
export const OCEAN_RADIUS = 60000;

/**
 * Find the geometric growth rate that takes `rings` steps from `minSpacing` out
 * to `rMax`, where step(r) = max(minSpacing, r * growth).
 *
 * Bisection: radius after N steps is monotonic in growth, so this converges
 * quickly and exactly enough for geometry construction.
 */
function solveGrowth( rings, minSpacing, rMax ) {

	const reach = ( growth ) => {

		let r = 0;
		for ( let i = 0; i < rings; i ++ ) r += Math.max( minSpacing, r * growth );
		return r;

	};

	let lo = 1e-4;
	let hi = 0.5;

	for ( let i = 0; i < 60; i ++ ) {

		const mid = ( lo + hi ) * 0.5;
		if ( reach( mid ) < rMax ) lo = mid; else hi = mid;

	}

	return ( lo + hi ) * 0.5;

}

/**
 * @param {object} tier  one of GEOMETRY_TIERS
 * @returns {{geometry: BufferGeometry, growth: number, radii: Float32Array, triangles: number}}
 */
export function createOceanGeometry( tier ) {

	const rings = tier.rings;
	const sectors = tier.sectors;

	const growth = solveGrowth( rings, tier.minSpacing, OCEAN_RADIUS );

	// Ring radii.
	const radii = new Float32Array( rings );
	let r = 0;
	for ( let i = 0; i < rings; i ++ ) {

		r += Math.max( tier.minSpacing, r * growth );
		radii[ i ] = r;

	}

	const vertexCount = 1 + rings * sectors;
	const positions = new Float32Array( vertexCount * 3 );

	// Centre vertex.
	positions[ 0 ] = 0;
	positions[ 1 ] = 0;
	positions[ 2 ] = 0;

	// Precompute the sector directions once instead of calling sin/cos per vertex
	// per ring (sectors * rings trig calls -> sectors).
	const dirX = new Float32Array( sectors );
	const dirZ = new Float32Array( sectors );

	for ( let s = 0; s < sectors; s ++ ) {

		const a = ( s / sectors ) * Math.PI * 2;
		dirX[ s ] = Math.cos( a );
		dirZ[ s ] = Math.sin( a );

	}

	let p = 3;

	for ( let i = 0; i < rings; i ++ ) {

		const rr = radii[ i ];

		for ( let s = 0; s < sectors; s ++ ) {

			positions[ p ++ ] = dirX[ s ] * rr;
			positions[ p ++ ] = 0;
			positions[ p ++ ] = dirZ[ s ] * rr;

		}

	}

	// Indices: a fan from the centre to ring 0, then quad strips between rings.
	const triangles = sectors + ( rings - 1 ) * sectors * 2;
	const IndexArray = vertexCount > 65535 ? Uint32Array : Uint16Array;
	const indices = new IndexArray( triangles * 3 );

	let t = 0;

	// Centre fan. Winding is CCW when viewed from +Y.
	for ( let s = 0; s < sectors; s ++ ) {

		const a = 1 + s;
		const b = 1 + ( s + 1 ) % sectors;
		indices[ t ++ ] = 0;
		indices[ t ++ ] = b;
		indices[ t ++ ] = a;

	}

	for ( let i = 0; i < rings - 1; i ++ ) {

		const base = 1 + i * sectors;
		const next = base + sectors;

		for ( let s = 0; s < sectors; s ++ ) {

			const s1 = ( s + 1 ) % sectors;

			const a = base + s;
			const b = base + s1;
			const c = next + s;
			const d = next + s1;

			indices[ t ++ ] = a;
			indices[ t ++ ] = b;
			indices[ t ++ ] = c;

			indices[ t ++ ] = b;
			indices[ t ++ ] = d;
			indices[ t ++ ] = c;

		}

	}

	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position', new BufferAttribute( positions, 3 ) );
	geometry.setIndex( new BufferAttribute( indices, 1 ) );

	// The mesh follows the camera and is displaced in the vertex stage, so any
	// computed bound would be wrong. Give it an explicit generous sphere and
	// disable culling on the mesh itself.
	geometry.boundingSphere = new Sphere( new Vector3( 0, 0, 0 ), OCEAN_RADIUS * 1.1 );
	geometry.computeBoundingBox();

	return { geometry, growth, radii, triangles, vertexCount };

}
