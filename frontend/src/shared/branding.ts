/** The product's own name, shown when the backend does not name the instance. */
export const DEFAULT_APP_NAME = 'Pi Local';

/** The instance name to show: the platform's, or the product's. */
export function instanceName(appName: string | null | undefined): string {
  return appName?.trim() || DEFAULT_APP_NAME;
}
