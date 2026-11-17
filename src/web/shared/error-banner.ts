/**
 * The inline, dismissible error message every tool shows under its action
 * button. One implementation so a failure looks and behaves the same
 * everywhere - and never as a blocking `alert()`.
 *
 * Markup: `<div class="inline-error" id="error-banner" hidden role="alert"></div>`.
 * The message is set as text, so file-derived content needs no escaping.
 */
export interface ErrorBanner {
  show(message: string): void;
  hide(): void;
}

export function setupErrorBanner(id = 'error-banner'): ErrorBanner {
  const container = document.getElementById(id)!;

  const message = document.createElement('span');
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'inline-error-dismiss';
  dismiss.title = 'Dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.textContent = '✕';
  container.replaceChildren(message, dismiss);

  const hide = () => {
    container.hidden = true;
    message.textContent = '';
  };
  dismiss.addEventListener('click', hide);

  return {
    show(text: string) {
      message.textContent = text;
      container.hidden = false;
      // Results below can be long; make sure the message is actually seen.
      container.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    },
    hide,
  };
}

/** The text to show for anything thrown. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}
