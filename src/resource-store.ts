/**
 * In-memory backing store for the resource provider: MFD-originated
 * resources plus anything created directly through this plugin's provider.
 * The provider answers from here immediately and never blocks on MFD I/O.
 */

import { canonicalize } from './mapper';
import type { Resource, ResourceType, RouteResource, WaypointResource } from './types';

export class ResourceStore {
  private readonly maps: Record<ResourceType, Map<string, Resource>> = {
    routes: new Map(),
    waypoints: new Map(),
  };

  list(type: ResourceType): Record<string, Resource> {
    return Object.fromEntries(this.maps[type]);
  }

  get(type: ResourceType, id: string): Resource | undefined {
    return this.maps[type].get(id);
  }

  ids(type: ResourceType): string[] {
    return [...this.maps[type].keys()];
  }

  owns(id: string): boolean {
    return this.maps.routes.has(id) || this.maps.waypoints.has(id);
  }

  /** Set; returns true if the canonical content actually changed. */
  set(type: ResourceType, id: string, resource: Resource): boolean {
    const existing = this.maps[type].get(id);
    if (existing && canonicalize(type, existing) === canonicalize(type, resource)) {
      this.maps[type].set(type === 'routes' ? id : id, resource);
      return false;
    }
    this.maps[type].set(id, resource);
    return true;
  }

  /** Delete; returns true if the resource existed. */
  delete(type: ResourceType, id: string): boolean {
    return this.maps[type].delete(id);
  }

  routes(): Map<string, RouteResource> {
    return new Map(this.maps.routes as Map<string, RouteResource>);
  }

  waypoints(): Map<string, WaypointResource> {
    return new Map(this.maps.waypoints as Map<string, WaypointResource>);
  }
}
