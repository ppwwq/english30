import assert from 'node:assert/strict';

export function allowBeforeUnload(page) {
  page.on('dialog', async (dialog) => {
    const type = dialog.type();
    if (type === 'beforeunload') return dialog.accept();
    await dialog.dismiss();
    assert.fail('Unexpected native browser dialog: ' + type);
  });
}

export async function answerConfirmation(page, action) {
  const dialog = page.getByRole('dialog');
  const message = await dialog.innerText();
  await dialog.getByRole('button', { name: action, exact: true }).click();
  return message;
}

// Single-group Tasks and completed answers submit without the incomplete-Task prompt.
export async function confirmIncompleteTask(page) {
  if (await page.getByRole('dialog', { name: '交整份 Task？' }).isVisible())
    await answerConfirmation(page, '确认交卷');
}
