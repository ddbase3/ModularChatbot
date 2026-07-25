export function encodeBase64Url(value) {
	const bytes = new TextEncoder().encode(String(value));
	let binary = '';

	bytes.forEach((byte) => {
		binary += String.fromCharCode(byte);
	});

	return btoa(binary)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/g, '');
}
