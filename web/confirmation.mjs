let pending;

export function dismissConfirmation() {
  pending?.(false);
}

// A second request must never inherit consent for the first action.
export function confirmAction(title, content, action) {
  if (pending) return Promise.resolve(false);
  const dialog = document.createElement('dialog');
  dialog.className = 'account-save-dialog';
  const heading = document.createElement('h2');
  heading.id = 'confirmation-title';
  heading.textContent = title;
  dialog.setAttribute('aria-labelledby', heading.id);
  dialog.append(heading);
  if (typeof content === 'string') {
    const description = document.createElement('p');
    description.id = 'confirmation-message';
    description.textContent = content;
    dialog.setAttribute('aria-describedby', description.id);
    dialog.append(description);
  } else dialog.append(...content);

  return new Promise((resolve) => {
    function finish(accepted) {
      if (pending !== finish) return;
      pending = null;
      dialog.close();
      dialog.remove();
      resolve(accepted);
    }
    const actions = document.createElement('div');
    actions.className = 'account-actions';
    for (const [label, accepted] of [
      ['取消', false],
      [action, true],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = accepted ? 'button-primary' : 'button-secondary';
      button.textContent = label;
      button.autofocus = !accepted;
      button.onclick = () => finish(accepted);
      actions.append(button);
    }
    dialog.append(actions);
    dialog.onkeydown = (event) => event.stopPropagation();
    dialog.oncancel = (event) => {
      event.preventDefault();
      finish(false);
    };
    dialog.onclose = () => finish(false);
    document.body.append(dialog);
    pending = finish;
    dialog.showModal();
  });
}
