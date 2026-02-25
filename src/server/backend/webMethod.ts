// =============================================================================
// webMethod — Wix-compatible secure backend function wrapper
// =============================================================================
// In the Wix Velo ecosystem, `webMethod(Permissions.Admin, fn)` wraps a
// backend function so that:
//   1. It can be called from the frontend via HTTP
//   2. Only callers with the required permission level can execute it
//
// Since this project is a self-hosted Wix CLI app running on Express,
// the Wix Velo runtime is not available directly. This module provides
// a production-grade local implementation that mirrors the Wix pattern:
//
//   - `Permissions` enum defines access levels (Anyone, SiteMember, Admin)
//   - `webMethod()` wraps functions with permission metadata
//   - `executeWebMethod()` runs them after verifying the caller's role
//
// When the app is migrated to Wix Blocks or Wix Velo, these can be swapped
// for the platform-native `import { webMethod, Permissions } from 'wix-web-module';`
// =============================================================================

import logger from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Permissions enum — mirrors wix-web-module/Permissions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Permission levels for backend methods.
 *
 * - `Anyone`     — No authentication required (public)
 * - `SiteMember` — Requires logged-in site member
 * - `Admin`      — Requires site owner / admin (dashboard context)
 */
export enum Permissions {
  /** Public — no auth required */
  Anyone = 'Anyone',

  /** Logged-in site member */
  SiteMember = 'SiteMember',

  /** Site owner / dashboard admin — highest privilege */
  Admin = 'Admin',
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Caller context passed to web methods when executed */
export interface WebMethodContext {
  /** Wix site instance ID (always present when authenticated) */
  instanceId: string;
  /** The caller's resolved permission level */
  role: Permissions;
}

/**
 * A function wrapped by `webMethod`. The original function signature is
 * preserved, but a `__permission` property is attached for runtime checks.
 */
export interface WrappedWebMethod<T extends (...args: any[]) => any> {
  (...args: Parameters<T>): ReturnType<T>;
  /** The required permission level */
  __permission: Permissions;
  /** Original unwrapped function (for testing) */
  __original: T;
}

// ─────────────────────────────────────────────────────────────────────────────
// webMethod — the wrapper function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wrap a backend function with a permission requirement.
 *
 * Usage mirrors Wix Velo:
 * ```ts
 * export const getStatus = webMethod(Permissions.Admin, async (instanceId: string) => {
 *   return await getConnectionStatus(instanceId);
 * });
 * ```
 *
 * @param permission — Required permission level to call this method
 * @param fn         — The implementation function
 * @returns          — The wrapped function with `__permission` metadata
 */
export function webMethod<T extends (...args: any[]) => any>(
  permission: Permissions,
  fn: T,
): WrappedWebMethod<T> {
  const wrapped = ((...args: Parameters<T>): ReturnType<T> => {
    return fn(...args);
  }) as WrappedWebMethod<T>;

  wrapped.__permission = permission;
  wrapped.__original = fn;

  return wrapped;
}

// ─────────────────────────────────────────────────────────────────────────────
// Permission verification helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Numeric weight for permission comparison */
const PERMISSION_LEVEL: Record<Permissions, number> = {
  [Permissions.Anyone]: 0,
  [Permissions.SiteMember]: 1,
  [Permissions.Admin]: 2,
};

/**
 * Check whether a caller's role meets the required permission.
 *
 * @param required — The permission level the method demands
 * @param caller   — The caller's actual permission level
 * @returns        — True if the caller has sufficient privileges
 */
export function hasPermission(required: Permissions, caller: Permissions): boolean {
  return PERMISSION_LEVEL[caller] >= PERMISSION_LEVEL[required];
}

/**
 * Execute a wrapped web method with permission verification.
 *
 * @param method  — The wrapped web method to execute
 * @param context — Caller context (instanceId + role)
 * @param args    — Arguments to pass to the method
 * @throws        — Error if the caller lacks the required permission
 */
export async function executeWebMethod<T extends (...args: any[]) => any>(
  method: WrappedWebMethod<T>,
  context: WebMethodContext,
  ...args: Parameters<T>
): Promise<ReturnType<T>> {
  // Permission gate
  if (!hasPermission(method.__permission, context.role)) {
    logger.warn('Permission denied for web method call', {
      required: method.__permission,
      callerRole: context.role,
      instanceId: context.instanceId,
    });
    throw new Error(
      `Permission denied: requires ${method.__permission}, caller has ${context.role}`,
    );
  }

  return method(...args) as ReturnType<T>;
}
