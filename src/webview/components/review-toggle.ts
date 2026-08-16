/**
 * The marker on the control that opens the fleet diff surface.
 *
 * Shared rather than duplicated because the two ends of it live in different
 * components: `SessionPicker` renders the toggle, and `FleetDiff` — which
 * replaces the panel body while it is open — has to find that toggle again on
 * the way out to give focus back to it. A selector spelled twice is a selector
 * that eventually only matches once.
 *
 * A `data-` attribute rather than the accessible name: the name is user-facing
 * copy and will be reworded, and focus restoration must not be the thing that
 * breaks when it is.
 */
export const REVIEW_TOGGLE_ATTR = 'data-review-toggle';
