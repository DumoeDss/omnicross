/**
 * `CorePaths` — core-owned port for the narrow filesystem-path slice the serving
 * core reads from the host `AppPaths`.
 *
 * The serving core (and the host's config service) read only
 * `userData` and `resourcesDir`. The serving core MUST depend on THIS interface,
 * never on the concrete host `AppPaths` class as a type. `AppPaths` exposes a
 * superset, so it is passed directly with NO adapter.
 *
 * @module ports/core-paths
 */

export interface CorePaths {
  readonly userData: string;
  readonly resourcesDir: string;
}
