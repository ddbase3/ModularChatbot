export function formatDeleteQuestion(prefix, title, suffix) {
	return String(prefix || '') + String(title || '') + String(suffix || '');
}


export function resolveConversationTitle(conversation, trigger = null) {
	const conversationTitle = String(conversation?.title || '').trim();
	if (conversationTitle !== '') {
		return conversationTitle;
	}

	const triggerTitle = String(trigger?.dataset?.conversationTitle || '').trim();
	if (triggerTitle !== '') {
		return triggerTitle;
	}

	const visibleTitle = trigger?.closest?.('.base3-chatbot-conversation-item')
		?.querySelector?.('.base3-chatbot-conversation-select')?.textContent;
	return String(visibleTitle || '').trim();
}

function appendIcon(button, icon) {
	if (!icon) {
		return;
	}

	const image = document.createElement('img');
	image.src = icon;
	image.alt = '';
	image.setAttribute('aria-hidden', 'true');
	button.appendChild(image);
}

function createButton(label, className, icon = '') {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = className;
	button.setAttribute('aria-label', label);
	button.title = label;
	appendIcon(button, icon);
	return button;
}

export class ConversationView {
	constructor(context, options = {}) {
		this.context = context;
		this.options = options;
		this.strings = options.strings || {};
		this.icons = options.icons || {};
		this.multiple = options.multiple === true;
		this.panelMode = String(options.panelMode || 'responsive');
		this.onActivate = options.onActivate || (() => {});
		this.onRename = options.onRename || (() => {});
		this.onDelete = options.onDelete || (() => {});
		this.panel = context.root.querySelector('[data-chatbot-conversation-panel]');
		this.list = context.root.querySelector('[data-chatbot-conversation-list]');
		this.backdrop = context.root.querySelector('[data-chatbot-conversation-backdrop]');
		this.collapseButton = context.root.querySelector('[data-chatbot-conversation-collapse]');
		this.dialog = context.root.querySelector('[data-chatbot-conversation-delete-dialog]');
		this.dialogText = context.root.querySelector('[data-chatbot-conversation-delete-text]');
		this.dialogConfirm = context.root.querySelector('[data-chatbot-conversation-delete-confirm]');
		this.dialogCancel = context.root.querySelector('[data-chatbot-conversation-delete-cancel]');
		this.toggleButton = null;
		this.newButton = null;
		this.activeConversationId = '';
		this.busy = false;
		this.enabled = false;
		this.available = false;
		this.open = false;
		this.pendingDelete = null;
		this.backgroundElements = [
			context.root.querySelector('[data-chatbot-opening-message]'),
			context.root.querySelector('[data-chatbot-main]'),
			context.root.querySelector('[data-chatbot-composer]'),
			context.root.querySelector('.base3-chatbot-ai-notice'),
			context.root.querySelector('[data-chatbot-canvas]')
		].filter(Boolean);
		this.unsubscribeLayout = null;
		this.handleKeyboardNavigation = (event) => {
			if (event.key === 'Tab' || event.key.startsWith('Arrow')) {
				this.context.root.classList.add('is-keyboard-navigation');
			}
		};
		this.handlePointerNavigation = () => {
			this.context.root.classList.remove('is-keyboard-navigation');
		};
		this.handleLayoutChange = ({ compact }) => {
			if (this.enabled && this.panelMode === 'responsive') {
				this.setOpen(!compact, false, false);
			}
		};
	}

	init() {
		if (!this.panel || !this.list) {
			throw new Error('Conversation panel markup is missing.');
		}

		this.context.root.addEventListener('keydown', this.handleKeyboardNavigation, {
			signal: this.context.signal,
			capture: true
		});
		this.context.root.addEventListener('pointerdown', this.handlePointerNavigation, {
			signal: this.context.signal,
			capture: true
		});

		this.panel.hidden = true;
		this.panel.setAttribute('aria-hidden', 'true');
		this.collapseButton?.addEventListener('click', () => this.setOpen(false, true), {
			signal: this.context.signal
		});
		this.backdrop?.addEventListener('click', () => this.setOpen(false, true), {
			signal: this.context.signal
		});
		this.context.root.addEventListener('keydown', (event) => {
			if (event.key === 'Escape' && this.open && !this.dialog?.open) {
				event.preventDefault();
				this.setOpen(false, true);
			}
		}, { signal: this.context.signal });
		this.panel.addEventListener('keydown', (event) => this.trapMobileFocus(event), {
			signal: this.context.signal
		});
		this.dialogCancel?.addEventListener('click', () => this.closeDeleteDialog(), {
			signal: this.context.signal
		});
		this.dialogConfirm?.addEventListener('click', async () => {
			const conversation = this.pendingDelete;
			if (!conversation || this.busy) {
				return;
			}
			this.closeDeleteDialog(false);
			const deleted = await this.onDelete(conversation);
			if (!deleted) {
				conversation.trigger?.focus();
			}
		}, { signal: this.context.signal });
		this.dialog?.addEventListener('cancel', (event) => {
			event.preventDefault();
			this.closeDeleteDialog();
		}, { signal: this.context.signal });
	}

	enable() {
		if (!this.multiple || this.enabled) {
			return;
		}

		this.enabled = true;
		this.context.root.classList.add('has-conversation-support');
		if (this.panelMode === 'open') {
			this.setOpen(true, false, false);
		} else if (this.panelMode === 'closed') {
			this.setOpen(false, false, false);
		} else {
			this.setOpen(false, false, false);
			this.unsubscribeLayout = this.context.events.on('layout:changed', this.handleLayoutChange);
			this.context.chatbot.updateLayoutMode();
			this.setOpen(!this.isCompactLayout(), false, false);
		}
	}

	setAvailable(available) {
		this.available = Boolean(available);
		this.setBusy(this.busy);
	}

	setControls(toggleButton, newButton) {
		this.toggleButton = toggleButton;
		this.newButton = newButton;
		if (this.toggleButton) {
			this.toggleButton.setAttribute('aria-controls', this.panel.id);
			this.toggleButton.setAttribute('aria-expanded', this.open ? 'true' : 'false');
		}
		this.setBusy(this.busy);
	}

	setOpen(open, restoreFocus = false, focusPanel = true) {
		if (!this.multiple || !this.enabled) {
			return;
		}

		this.open = Boolean(open);
		this.context.root.classList.toggle('is-conversation-panel-open', this.open);
		this.panel.hidden = !this.open;
		this.panel.setAttribute('aria-hidden', this.open ? 'false' : 'true');
		if (this.backdrop) {
			this.backdrop.hidden = !this.open || !this.isCompactLayout();
		}
		this.setBackgroundInert(this.open && this.isCompactLayout());
		if (this.toggleButton) {
			this.toggleButton.setAttribute('aria-expanded', this.open ? 'true' : 'false');
		}

		if (this.open && focusPanel) {
			window.setTimeout(() => {
				const active = this.list.querySelector('[aria-current="page"]');
				(active || this.collapseButton)?.focus();
			}, 0);
		} else if (!this.open && restoreFocus) {
			this.toggleButton?.focus();
		}
	}

	setBackgroundInert(inert) {
		this.backgroundElements.forEach((element) => {
			element.inert = Boolean(inert);
		});
	}

	isCompactLayout() {
		return this.context.chatbot.isCompactLayout();
	}

	trapMobileFocus(event) {
		if (event.key !== 'Tab' || !this.open || !this.isCompactLayout()) {
			return;
		}

		const focusable = [...this.panel.querySelectorAll('button:not(:disabled), input:not(:disabled)')]
			.filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
		if (focusable.length === 0) {
			return;
		}

		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	}

	toggle() {
		const next = !this.open;
		this.setOpen(next, !next, next);
	}

	setBusy(busy) {
		this.busy = Boolean(busy);
		const disabled = this.busy || !this.available;
		if (this.toggleButton) {
			this.toggleButton.disabled = disabled;
		}
		if (this.newButton) {
			this.newButton.disabled = disabled;
		}
		this.list?.querySelectorAll('button, input').forEach((element) => {
			element.disabled = disabled;
		});
		if (this.dialogConfirm) {
			this.dialogConfirm.disabled = disabled;
		}
	}

	renderStatus(message) {
		if (!this.multiple || !this.list) {
			return;
		}

		const item = document.createElement('li');
		item.className = 'base3-chatbot-conversation-status';
		item.textContent = String(message || '');
		this.list.replaceChildren(item);
	}

	render(state, focusConversationId = '') {
		this.activeConversationId = state.active_conversation?.id || '';
		if (!this.multiple) {
			return;
		}

		this.list.replaceChildren();
		state.conversations.forEach((conversation) => {
			this.list.appendChild(this.createConversationItem(conversation));
		});
		this.setBusy(this.busy);

		if (focusConversationId) {
			window.setTimeout(() => {
				this.list.querySelector(`[data-conversation-id="${CSS.escape(focusConversationId)}"] .base3-chatbot-conversation-select`)?.focus();
			}, 0);
		}
	}

	createConversationItem(conversation) {
		const item = document.createElement('li');
		item.className = 'base3-chatbot-conversation-item';
		item.dataset.conversationId = conversation.id;

		const select = document.createElement('button');
		select.type = 'button';
		select.className = 'base3-chatbot-conversation-select';
		select.textContent = conversation.title;
		select.title = conversation.title;
		if (conversation.id === this.activeConversationId) {
			select.setAttribute('aria-current', 'page');
		}
		select.addEventListener('click', async () => {
			if (conversation.id === this.activeConversationId || this.busy) {
				return;
			}
			await this.onActivate(conversation);
		}, { signal: this.context.signal });

		const actions = document.createElement('div');
		actions.className = 'base3-chatbot-conversation-actions';
		const edit = createButton(
			this.strings.renameConversation || this.context.getString('renameConversation'),
			'base3-chatbot-conversation-action',
			this.icons.edit
		);
		const remove = createButton(
			this.strings.deleteConversation || this.context.getString('deleteConversation'),
			'base3-chatbot-conversation-action',
			this.icons.delete
		);
		edit.addEventListener('click', () => this.startEditing(item, conversation), {
			signal: this.context.signal
		});
		remove.dataset.conversationTitle = String(select.textContent || '').trim();
		remove.addEventListener('click', () => this.openDeleteDialog({
			id: conversation.id,
			title: remove.dataset.conversationTitle
		}, remove), {
			signal: this.context.signal
		});
		actions.append(edit, remove);
		item.append(select, actions);
		return item;
	}

	startEditing(item, conversation) {
		if (this.busy) {
			return;
		}

		const form = document.createElement('form');
		form.className = 'base3-chatbot-conversation-edit';
		const label = document.createElement('label');
		label.className = 'base3-chatbot-visually-hidden';
		label.htmlFor = `${this.context.chatbot.instanceId}-conversation-title-${conversation.id}`;
		label.textContent = this.strings.titleLabel || this.context.getString('titleLabel');
		const input = document.createElement('input');
		input.id = label.htmlFor;
		input.type = 'text';
		input.className = 'base3-chatbot-conversation-title-input';
		input.value = conversation.title;
		input.maxLength = 255;
		input.required = true;
		const save = createButton(
			this.strings.saveTitle || this.context.getString('saveTitle'),
			'base3-chatbot-conversation-action',
			this.icons.save
		);
		save.type = 'submit';
		const cancel = createButton(
			this.strings.cancel || this.context.getString('cancel'),
			'base3-chatbot-conversation-action',
			this.icons.close
		);

		const restore = () => {
			const replacement = this.createConversationItem(conversation);
			item.replaceWith(replacement);
			replacement.querySelector('.base3-chatbot-conversation-select')?.focus();
		};
		form.addEventListener('submit', async (event) => {
			event.preventDefault();
			const title = input.value.trim();
			if (!title || this.busy) {
				input.reportValidity();
				return;
			}
			await this.onRename(conversation, title);
		}, { signal: this.context.signal });
		form.addEventListener('keydown', (event) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				restore();
			}
		}, { signal: this.context.signal });
		cancel.addEventListener('click', restore, { signal: this.context.signal });
		form.append(label, input, save, cancel);
		item.replaceChildren(form);
		input.focus();
		input.select();
	}

	openDeleteDialog(conversation, trigger) {
		if (!this.dialog || this.busy) {
			return;
		}

		const title = resolveConversationTitle(conversation, trigger);
		this.pendingDelete = {
			...conversation,
			title,
			trigger
		};
		if (this.dialogText) {
			this.dialogText.textContent = formatDeleteQuestion(
				this.strings.deleteQuestionPrefix,
				title,
				this.strings.deleteQuestionSuffix
			);
		}
		this.dialog.showModal();
		this.dialogCancel?.focus();
	}

	closeDeleteDialog(restoreFocus = true) {
		const pending = this.pendingDelete;
		this.pendingDelete = null;
		if (this.dialog?.open) {
			this.dialog.close();
		}
		if (restoreFocus) {
			pending?.trigger?.focus();
		}
	}

	destroy() {
		if (this.unsubscribeLayout) {
			this.unsubscribeLayout();
			this.unsubscribeLayout = null;
		}
		if (this.dialog?.open) {
			this.dialog.close();
		}
		this.enabled = false;
		this.open = false;
		this.setBackgroundInert(false);
		if (this.panel) {
			this.panel.hidden = true;
			this.panel.setAttribute('aria-hidden', 'true');
		}
		if (this.backdrop) {
			this.backdrop.hidden = true;
		}
		if (this.toggleButton) {
			this.toggleButton.setAttribute('aria-expanded', 'false');
		}
		this.context.root.classList.remove(
			'has-conversation-support',
			'is-conversation-panel-open',
			'is-keyboard-navigation'
		);
	}
}
