import { encodeBase64Url } from '../utils/encoding.js';

function normalizeReference(reference) {
	if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
		return null;
	}

	return {
		...reference,
		sentAt: new Date().toISOString()
	};
}

export function resolveReference(context) {
	const options = context.getPluginOptions('reference');
	const mode = String(options.mode || 'url').toLowerCase();
	let reference = null;

	if (mode === 'none') {
		return null;
	}
	if (mode === 'custom') {
		reference = normalizeReference(options.reference || null);
	} else if (mode === 'provider') {
		const provider = context.resolveGlobal(String(options.provider || '').trim());
		if (typeof provider === 'function') {
			reference = normalizeReference(provider({
				root: context.root,
				options: context.getOptions()
			}));
		}
	} else {
		reference = normalizeReference({
			type: 'page',
			url: window.location.href,
			title: document.title || '',
			referrer: document.referrer || ''
		});
	}

	return reference;
}

export const ReferencePlugin = {
	name: 'reference',

	transformRequest(context, payload) {
		const reference = resolveReference(context);
		if (!reference) {
			return payload;
		}

		return {
			...payload,
			reference: encodeBase64Url(JSON.stringify(reference)),
			reference_format: 'base64json'
		};
	}
};
