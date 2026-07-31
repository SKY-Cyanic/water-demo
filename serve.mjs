// Minimal static HTTP server for local verification.
// WebGPU + ES modules require http(s); file:// is not a valid test surface.
//   node serve.mjs [port]

import { createServer } from 'node:http';
import { createReadStream, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname);
const PORT = Number(process.argv[2] || 8173);

const TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.svg': 'image/svg+xml',
	'.md': 'text/markdown; charset=utf-8',
};

createServer( ( req, res ) => {

	const url = new URL( req.url, 'http://localhost' );
	let path = decodeURIComponent( url.pathname );

	// QA sink: the page posts a PNG data URL from window.__capture() and we drop
	// it into qa/. Screenshots are then the real drawing buffer at a known size,
	// not whatever a window manager happened to composite.
	if ( req.method === 'POST' && path === '/__save' ) {

		let body = '';
		req.on( 'data', ( c ) => { body += c; } );
		req.on( 'end', () => {

			try {

				const { name, data } = JSON.parse( body );
				const png = Buffer.from( String( data ).split( ',' )[ 1 ], 'base64' );
				const dir = join( ROOT, 'qa' );
				mkdirSync( dir, { recursive: true } );
				const file = join( dir, basename( String( name ) ) );
				writeFileSync( file, png );
				console.log( `saved qa/${basename( String( name ) )}  ${png.length} bytes` );
				res.writeHead( 200, { 'content-type': 'text/plain' } ).end( 'qa/' + basename( String( name ) ) );

			} catch ( err ) {

				res.writeHead( 500, { 'content-type': 'text/plain' } ).end( 'save failed: ' + err.message );

			}

		} );

		return;

	}

	if ( path.endsWith( '/' ) ) path += 'index.html';

	const file = join( ROOT, normalize( path ).replace( /^(\.\.[/\\])+/, '' ) );

	if ( ! file.startsWith( ROOT ) ) {

		res.writeHead( 403 ).end( 'Forbidden' );
		return;

	}

	let stat;
	try {

		stat = statSync( file );

	} catch {

		res.writeHead( 404, { 'content-type': 'text/plain' } ).end( 'Not found: ' + path );
		return;

	}

	if ( stat.isDirectory() ) {

		res.writeHead( 302, { location: path + '/' } ).end();
		return;

	}

	res.writeHead( 200, {
		'content-type': TYPES[ extname( file ).toLowerCase() ] || 'application/octet-stream',
		'content-length': stat.size,
		// Always revalidate so the verification loop never serves a stale module.
		'cache-control': 'no-cache, no-store, must-revalidate',
	} );

	createReadStream( file ).pipe( res );

} ).listen( PORT, () => {

	console.log( `water-demo serving ${ROOT}` );
	console.log( `  http://localhost:${PORT}/` );

} );
