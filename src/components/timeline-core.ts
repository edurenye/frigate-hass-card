import add from 'date-fns/add';
import endOfHour from 'date-fns/endOfHour';
import differenceInSeconds from 'date-fns/differenceInSeconds';
import startOfHour from 'date-fns/startOfHour';
import sub from 'date-fns/sub';
import {
  CSSResultGroup,
  html,
  LitElement,
  PropertyValues,
  TemplateResult,
  unsafeCSS,
} from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { createRef, ref, Ref } from 'lit/directives/ref.js';
import isEqual from 'lodash-es/isEqual';
import throttle from 'lodash-es/throttle';
import { ViewContext } from 'view';
import { DataSet } from 'vis-data/esnext';
import type { DataGroupCollectionType, IdType } from 'vis-timeline/esnext';
import {
  Timeline,
  TimelineEventPropertiesResult,
  TimelineItem,
  TimelineOptions,
  TimelineOptionsCluster,
  TimelineWindow,
} from 'vis-timeline/esnext';
import { CAMERA_BIRDSEYE } from '../const';
import { localize } from '../localize/localize';
import timelineCoreStyle from '../scss/timeline-core.scss';
import {
  CameraConfig,
  ExtendedHomeAssistant,
  frigateCardConfigDefaults,
  FrigateCardView,
  TimelineCoreConfig,
} from '../types';
import { stopEventFromActivatingCardWideActions } from '../utils/action';
import {
  contentsChanged,
  dispatchFrigateCardEvent,
  isHoverableDevice,
} from '../utils/basic';

import {
  createViewForEvents,
  createViewForRecordings,
  findClosestMediaIndex,
} from '../utils/media-to-view';
import { CameraManager } from '../camera-manager/manager';
import { EventMediaQueries, MediaQueries } from '../view/media-queries';
import { MediaQueriesClassifier } from '../view/media-queries-classifier';
import { dispatchMessageEvent } from './message.js';
import './thumbnail.js';
import { FrigateCardTimelineItem, TimelineDataSource } from '../utils/timeline-source';
import { ViewMedia } from '../view/media';
import { ViewMediaClassifier } from '../view/media-classifier';
import { rangesOverlap } from '../camera-manager/range';
import { View } from '../view/view';
import { MediaQuery } from '../camera-manager/types';

interface FrigateCardGroupData {
  id: string;
  content: string;
}

interface TimelineRangeChange extends TimelineWindow {
  event: Event & { additionalEvent?: string };
  byUser: boolean;
}

interface TimelineViewContext {
  window?: TimelineWindow;
}

declare module 'view' {
  interface ViewContext {
    timeline?: TimelineViewContext;
  }
}

// An event used to fetch data required for thumbnail rendering. See special
// note below on why this is necessary.
interface ThumbnailDataRequest {
  item: IdType;
  hass?: ExtendedHomeAssistant;
  cameraManager?: CameraManager;
  cameraConfig?: CameraConfig;
  media?: ViewMedia;
  view?: View;
}

class ThumbnailDataRequestEvent extends CustomEvent<ThumbnailDataRequest> {}

const TIMELINE_TARGET_BAR_ID = 'target_bar';

/**
 * A simgple thumbnail wrapper class for use in the timeline where LIT data
 * bindings are not available.
 */
@customElement('frigate-card-timeline-thumbnail')
export class FrigateCardTimelineThumbnail extends LitElement {
  @property({ attribute: true })
  public item?: IdType;

  @property({ attribute: true, type: Boolean })
  public details = false;

  /**
   * Master render method.
   * @returns A rendered template.
   */
  protected render(): TemplateResult | void {
    if (!this.item) {
      return html``;
    }

    /* Special note on what's going on here:
     *
     * This component does not have access to a variety of properties required
     * to render a thumbnail component, as there's no way to pass them in via the
     * string-based tooltip that timeline supports. Instead dispatch an event to
     * request HASS which the timeline adds to the event object before execution
     * continues.
     */

    const dataRequest: ThumbnailDataRequest = {
      item: this.item,
    };
    this.dispatchEvent(
      new ThumbnailDataRequestEvent(`frigate-card:timeline:thumbnail-data-request`, {
        composed: true,
        bubbles: true,
        detail: dataRequest,
      }),
    );

    if (
      !dataRequest.hass ||
      !dataRequest.cameraManager ||
      !dataRequest.cameraConfig ||
      !dataRequest.media ||
      !dataRequest.view
    ) {
      return html``;
    }

    return html` <frigate-card-thumbnail
      .hass=${dataRequest.hass}
      .cameraManager=${dataRequest.cameraManager}
      .cameraConfig=${dataRequest.cameraConfig}
      .media=${dataRequest.media}
      .view=${dataRequest.view}
      ?details=${this.details}
    >
    </frigate-card-thumbnail>`;
  }
}

@customElement('frigate-card-timeline-core')
export class FrigateCardTimelineCore extends LitElement {
  @property({ attribute: false })
  public hass?: ExtendedHomeAssistant;

  @property({ attribute: false })
  public view?: Readonly<View>;

  @property({ attribute: false })
  public cameras?: Map<string, CameraConfig>;

  @property({ attribute: false, hasChanged: contentsChanged })
  public timelineConfig?: TimelineCoreConfig;

  @property({ attribute: true, type: Boolean })
  public thumbnailDetails? = false;

  @property({ attribute: false })
  public thumbnailSize?: number;

  // Whether or not this is a mini-timeline (in mini-mode the component takes a
  // supportive role for other views).
  @property({ attribute: true, type: Boolean, reflect: true })
  public mini = false;

  // Which cameraIDs to include in the timeline. If not specified, all cameraIDs
  // are shown.
  @property({ attribute: false, hasChanged: contentsChanged })
  public cameraIDs?: Set<string>;

  @property({ attribute: false })
  public cameraManager?: CameraManager;

  @state()
  protected _locked = false;

  protected _targetBarVisible = false;
  protected _refTimeline: Ref<HTMLElement> = createRef();
  protected _timeline?: Timeline;

  protected _timelineSource: TimelineDataSource | null = null;

  // Need a way to separate when a user clicks (to pan the timeline) vs when a
  // user clicks (to choose a recording (non-event) to play).
  protected _pointerHeld:
    | (TimelineEventPropertiesResult & { window?: TimelineWindow })
    | null = null;
  protected _ignoreClick = false;

  protected readonly _isHoverableDevice = isHoverableDevice();

  // Range changes are volumonous: throttle the calls on seeking.
  protected _throttledSetViewDuringRangeChange = throttle(
    this._setViewDuringRangeChange.bind(this),
    1000 / 10,
  );

  /**
   * Get a tooltip for a given timeline event.
   * @param item The TimelineItem in question.
   * @returns The tooltip as a string to render.
   */
  protected _getTooltip(item: TimelineItem): string {
    if (!this._isHoverableDevice) {
      // Don't display tooltips on touch devices, they just get in the way of
      // the drawer.
      return '';
    }

    // Cannot use Lit data-bindings as visjs requires a string for tooltips.
    // Note that changes to attributes here must be mirrored in the xss
    // whitelist in `_getOptions()` .
    return `
      <frigate-card-timeline-thumbnail
        item='${item.id}'
        ${this.thumbnailDetails ? 'details' : ''}
      >
      </frigate-card-timeline-thumbnail>`;
  }

  protected _handleThumbnailDataRequest(request: ThumbnailDataRequestEvent): void {
    const item = request.detail.item;
    const media = this._timelineSource?.dataset.get(item)?.media;

    request.detail.hass = this.hass;
    request.detail.cameraConfig = media
      ? this.cameras?.get(media.getCameraID())
      : undefined;
    request.detail.cameraManager = this.cameraManager;
    request.detail.media = media;
    request.detail.view = this.view;
  }

  /**
   * Master render method.
   * @returns A rendered template.
   */
  protected render(): TemplateResult | void {
    if (!this.hass || !this.view || !this.timelineConfig) {
      return;
    }
    return html`<div
      @frigate-card:timeline:thumbnail-data-request=${this._handleThumbnailDataRequest.bind(
        this,
      )}
      class="timeline"
      ${ref(this._refTimeline)}
    >
      <ha-icon
        class="lock"
        .icon=${`mdi:${this._locked ? 'lock' : 'lock-open-variant'}`}
        @click=${() => {
          this._locked = !this._locked;
        }}
        aria-label="${this._locked
          ? localize('timeline.unlock')
          : localize('timeline.lock')}"
        title="${this._locked ? localize('timeline.unlock') : localize('timeline.lock')}"
      >
      </ha-icon>
    </div>`;
  }

  /**
   * Get all the keys of the cameras in scope for this timeline.
   * @returns A set of camera ids (may be empty).
   */
  protected _getTimelineCameraIDs(): Set<string> {
    return this.cameraIDs ?? this._getAllCameraIDs();
  }

  /**
   * Get all the keys of all cameras.
   * @returns A set of camera ids (may be empty).
   */
  protected _getAllCameraIDs(): Set<string> {
    return new Set(this.cameras?.keys());
  }

  /**
   * Called whenever the range is in the process of being changed.
   * @param properties
   */
  protected _timelineRangeChangeHandler(properties: TimelineRangeChange): void {
    if (this._pointerHeld) {
      this._ignoreClick = true;
    }

    if (
      this._timeline &&
      properties.byUser &&
      // Do not adjust select children or seek during zoom events.
      properties.event.type !== 'wheel' &&
      properties.event.additionalEvent !== 'pinchin' &&
      properties.event.additionalEvent !== 'pinchout'
    ) {
      const targetTime = this._pointerHeld?.window
        ? add(properties.start, {
            seconds:
              (this._pointerHeld.time.getTime() -
                this._pointerHeld.window.start.getTime()) /
              1000,
          })
        : properties.end;

      if (this._pointerHeld) {
        this._setTargetBarAppropriately(targetTime);
      }

      this._throttledSetViewDuringRangeChange(targetTime, properties);
    }
  }

  /**
   * Set the target bar at a given time.
   * @param targetTime
   */
  protected _setTargetBarAppropriately(targetTime: Date): void {
    if (!this._timeline) {
      return;
    }

    const targetBarOn =
      !this._locked ||
      (this.mini &&
        this._timeline.getSelection().some((id) => {
          const item = this._timelineSource?.dataset?.get(id);
          return (
            item &&
            item.start &&
            item.end &&
            targetTime.getTime() >= item.start &&
            targetTime.getTime() <= item.end
          );
        }));

    if (targetBarOn) {
      if (!this._targetBarVisible) {
        this._timeline?.addCustomTime(targetTime, TIMELINE_TARGET_BAR_ID);
        this._targetBarVisible = true;
      } else {
        this._timeline?.setCustomTime(targetTime, TIMELINE_TARGET_BAR_ID);
      }
    } else {
      this._removeTargetBar();
    }
  }

  /**
   * Remove the target bar.
   */
  protected _removeTargetBar(): void {
    if (this._targetBarVisible) {
      this._timeline?.removeCustomTime(TIMELINE_TARGET_BAR_ID);
      this._targetBarVisible = false;
    }
  }

  /**
   * Set the view during a range change.
   * @param targetTime The target time.
   * @param properties The range change properties.
   * @returns
   */
  protected async _setViewDuringRangeChange(
    targetTime: Date,
    properties: TimelineRangeChange,
  ): Promise<void> {
    const results = this.view?.queryResults;
    const media = results?.getResults();
    if (
      !media ||
      !results ||
      !this._timeline ||
      !this.view ||
      !this.hass ||
      !this.cameraManager ||
      !this.cameraManager ||
      // Skip range changes that do not have hammerjs pan directions associated
      // with them, as these outliers cause media matching issues below.
      !properties.event.additionalEvent
    ) {
      return;
    }

    const canSeek = !!this.view?.isViewerView();
    const newResults = this._locked
      ? null
      : results
          .clone()
          .resetSelectedResult()
          .selectBestResult((media) =>
            findClosestMediaIndex(
              media,
              targetTime,
              this._getTimelineCameraIDs(),
              properties.event.additionalEvent === 'panright' ? 'end' : 'start',
            ),
          );

    if (
      canSeek ||
      (newResults &&
        newResults.hasSelectedResult() &&
        newResults.getResult() !== results.getResult())
    ) {
      this.view
        .evolve({
          ...(newResults &&
            newResults.hasSelectedResult() && { queryResults: newResults }),
        }) // Whether or not to set the timeline window.
        .mergeInContext({
          ...(canSeek && { mediaViewer: { seek: targetTime } }),
          ...this._setWindowInContext(properties),
        })
        .dispatchChangeEvent(this);
    }
  }

  /**
   * Called whenever the timeline is clicked.
   * @param properties The properties of the timeline click event.
   */
  protected async _timelineClickHandler(
    properties: TimelineEventPropertiesResult,
  ): Promise<void> {
    // Calls to stopEventFromActivatingCardWideActions() are included for
    // completeness. Timeline does not support card-wide events and they are
    // disabled in card.ts in `_getMergedActions`.
    if (
      this._ignoreClick ||
      (properties.what &&
        ['item', 'background', 'group-label', 'axis'].includes(properties.what))
    ) {
      stopEventFromActivatingCardWideActions(properties.event);
    }

    if (
      this._ignoreClick ||
      !this.hass ||
      !this._timeline ||
      !this.cameras ||
      !this.view ||
      !this.cameraManager ||
      !properties.what
    ) {
      return;
    }

    let view: View | null = null;

    if (
      this.timelineConfig?.show_recordings &&
      ['background', 'group-label'].includes(properties.what)
    ) {
      view = await createViewForRecordings(
        this,
        this.hass,
        this.cameraManager,
        this.cameras,
        this.view,
        {
          targetTime:
            properties.what === 'background'
              ? properties.time
              : this._timeline.getWindow().end,
          ...(properties.group && {
            cameraIDs: new Set([String(properties.group)]),
          }),
        },
      );
    } else if (this.timelineConfig?.show_recordings && properties.what === 'axis') {
      view = await createViewForRecordings(
        this,
        this.hass,
        this.cameraManager,
        this.cameras,
        this.view,
        {
          cameraIDs: this._getAllCameraIDs(),
          start: startOfHour(properties.time),
          end: endOfHour(properties.time),
          targetTime: properties.time,
        },
      );
    } else if (properties.item && properties.what === 'item') {
      const newResults = this.view.queryResults
        ?.clone()
        .resetSelectedResult()
        .selectResultIfFound(
          (media) => !!this.cameras && media.getID() === properties.item,
        );

      if (!newResults || !newResults.hasSelectedResult()) {
        // This can happen if this is a recording query (with recorded hours)
        // and an event is clicked on the timeline, or if the current thumbnails
        // is a filtered view from the media gallery (i.e. any case where the
        // thumbnails may not be match the events on the timeline).
        const fullEventView = await this._createViewWithEventMediaQuery(
          this._createEventMediaQuerys(),
          {
            selectedItem: properties.item,
            targetView: 'media',
          },
        );
        if (fullEventView?.queryResults?.hasResults()) {
          view = fullEventView;
        }
      } else {
        view = this.view.evolve({
          queryResults: newResults,
        });
      }

      if (view?.queryResults?.hasResults()) {
        view.mergeInContext({ mediaViewer: { seek: properties.time } });
      }
    }

    if (view) {
      view
        // If the user is clicking something in the timeline, don't
        // subsequently shift the window (it's pretty jarring).
        .dispatchChangeEvent(this);

      if (this.view?.is('timeline')) {
        dispatchFrigateCardEvent(this, 'thumbnails:open');
      }
    } else if (this.view?.is('timeline')) {
      dispatchFrigateCardEvent(this, 'thumbnails:close');
    }

    this._ignoreClick = false;
  }

  /**
   * Get a broader prefetch window from a start and end basis.
   * @param window The window to broaden.
   * @returns A broader timeline.
   */
  protected _getPrefetchWindow(window: TimelineWindow): TimelineWindow {
    const delta = differenceInSeconds(window.end, window.start);
    return {
      start: sub(window.start, { seconds: delta }),
      end: add(window.end, { seconds: delta }),
    };
  }

  /**
   * Handle a range change in the timeline.
   * @param properties vis.js provided range information.
   */
  protected async _timelineRangeChangedHandler(properties: {
    start: Date;
    end: Date;
    byUser: boolean;
    event: Event & { additionalEvent: string };
  }): Promise<void> {
    if (!properties.byUser) {
      return;
    }
    this._removeTargetBar();

    if (!this.hass || !this.cameras) {
      return;
    }

    const prefetchedWindow = this._getPrefetchWindow(properties);
    await this._timelineSource?.refresh(this.hass, prefetchedWindow);

    // Don't show event thumbnails if the user is looking at recordings,
    // as the recording "hours" are the media, not the event
    // clips/snapshots.
    if (
      this._timeline &&
      this.view &&
      !MediaQueriesClassifier.areRecordingQueries(this.view.query)
    ) {
      const newView = await this._createViewWithEventMediaQuery(
        this._createEventMediaQuerys({ window: this._timeline.getWindow() }),
      );

      // Specifically avoid dispatching new results on range change unless there
      // is something to be gained by doing so. Example usecase: On initial view
      // load in mini timeline mode, the first 50 events are fetched -- the
      // first drag of the timeline should not dispatch new results unless
      // something is actually useful (as otherwise it creates a visible
      // 'flicker' for the user as the viewer reloads all the media).
      const newResults = newView?.queryResults;
      if (newView && newResults && !this.view.queryResults?.isSupersetOf(newResults)) {
        newView?.mergeInContext(this._setWindowInContext())?.dispatchChangeEvent(this);
      }
    }
  }

  protected _createEventMediaQuerys(options?: {
    window?: TimelineWindow;
  }): EventMediaQueries | null {
    if (!this._timeline || !this._timelineSource) {
      return null;
    }

    const cacheFriendlyWindow = this._timelineSource.getCacheFriendlyEventWindow(
      options?.window ?? this._timeline.getWindow(),
    );

    const eventQueries =
      this._timelineSource.getTimelineEventQueries(cacheFriendlyWindow);
    if (!eventQueries) {
      return null;
    }
    return new EventMediaQueries(eventQueries);
  }

  protected async _createViewWithEventMediaQuery(
    query: EventMediaQueries | null,
    options?: {
      targetView?: FrigateCardView;
      selectedItem?: IdType;
    },
  ): Promise<View | null> {
    if (!this.hass || !this.cameraManager || !this.cameras || !this.view || !query) {
      return null;
    }
    const view = await createViewForEvents(
      this,
      this.hass,
      this.cameraManager,
      this.cameras,
      this.view,
      {
        query: query,
        targetView: options?.targetView,
        mediaType: this.timelineConfig?.media,
      },
    );
    if (!view) {
      return null;
    }
    if (options?.selectedItem) {
      view.queryResults?.selectResultIfFound(
        (media) => !!this.cameras && media.getID() === options.selectedItem,
      );
    } else {
      // If not asked to select a new item, persist the currently selected item
      // if possible.
      const currentlySelectedResult = this.view.queryResults?.getSelectedResult();
      if (currentlySelectedResult) {
        view.queryResults?.selectResultIfFound(
          (media) => media.getID() === currentlySelectedResult.getID(),
        );
      }
    }
    return view;
  }

  /**
   * Build the visjs dataset to render on the timeline.
   * @returns The dataset.
   */
  protected _getGroups(): DataGroupCollectionType {
    const groups: FrigateCardGroupData[] = [];

    this._getTimelineCameraIDs().forEach((cameraID) => {
      const cameraConfig = this.cameras?.get(cameraID);
      if (!this.hass || !cameraConfig || !this.cameraManager) {
        return;
      }
      const cameraMetadata = this.cameraManager.getCameraMetadata(
        this.hass,
        cameraConfig,
      );
      if (
        cameraMetadata &&
        cameraConfig.frigate.camera_name &&
        cameraConfig.frigate.camera_name !== CAMERA_BIRDSEYE
      ) {
        groups.push({
          id: cameraID,
          content: cameraMetadata.title,
        });
      }
    });
    return new DataSet(groups);
  }

  protected _getPerfectWindowFromMedia(media: ViewMedia): TimelineWindow | null {
    const startTime = media.getStartTime();
    const endTime = media.getEndTime();

    if (ViewMediaClassifier.isEvent(media)) {
      const windowSeconds = this._getConfiguredWindowSeconds();

      if (startTime && endTime) {
        if (endTime.getTime() - startTime.getTime() > windowSeconds * 1000) {
          // If the event is larger than the configured window, only show the most
          // recent portion of the event that fits in the window.
          return {
            start: sub(endTime, { seconds: windowSeconds }),
            end: endTime,
          };
        } else {
          // If the event is shorter than the configured window, center the event
          // in the window.
          const gap = windowSeconds - (endTime.getTime() - startTime.getTime()) / 1000;
          return {
            start: sub(startTime, { seconds: gap / 2 }),
            end: add(endTime, { seconds: gap / 2 }),
          };
        }
      } else if (startTime) {
        // If there's no end-time yet, place the start-time in the center of the
        // time window.
        return {
          start: sub(startTime, { seconds: windowSeconds / 2 }),
          end: add(startTime, { seconds: windowSeconds / 2 }),
        };
      }
    } else if (ViewMediaClassifier.isRecording(media) && startTime && endTime) {
      return {
        start: startTime,
        end: endTime,
      };
    }
    return null;
  }

  /**
   * Get the configured window length in seconds.
   */
  protected _getConfiguredWindowSeconds(): number {
    return (
      this.timelineConfig?.window_seconds ??
      frigateCardConfigDefaults.timeline.window_seconds
    );
  }

  /**
   * Get desired timeline start/end time.
   * @returns A tuple of start/end date.
   */
  protected _getDefaultStartEnd(): TimelineWindow {
    const end = new Date();
    const start = sub(end, {
      seconds: this._getConfiguredWindowSeconds(),
    });
    return { start: start, end: end };
  }

  /**
   * Determine if the timeline should use clustering.
   * @returns `true` if the timeline should cluster, `false` otherwise.
   */
  protected _isClustering(): boolean {
    return (
      !!this.timelineConfig?.clustering_threshold &&
      this.timelineConfig.clustering_threshold > 0
    );
  }

  /**
   * Get timeline options.
   */
  protected _getOptions(): TimelineOptions | null {
    if (!this.timelineConfig) {
      return null;
    }

    const defaultWindow = this._getDefaultStartEnd();

    // Configuration for the Timeline, see:
    // https://visjs.github.io/vis-timeline/docs/timeline/#Configuration_Options
    return {
      cluster: this._isClustering()
        ? {
            // It would be better to automatically calculate `maxItems` from the
            // rendered height of the timeline (or group within the timeline) so
            // as to not waste vertical space (e.g. after the user changes to
            // fullscreen mode). Unfortunately this is not easy to do, as we
            // don't know the height of the timeline until after it renders --
            // and if we adjust `maxItems` then we can get into an infinite
            // resize loop. Adjusting the `maxItems` of a timeline, after it's
            // created, also does not appear to work as expected.
            maxItems: this.timelineConfig.clustering_threshold,

            clusterCriteria: (first: TimelineItem, second: TimelineItem): boolean => {
              if (!this.cameras) {
                return false;
              }

              const media = this.view?.queryResults?.getSelectedResult();
              const selectedId = media?.getID();
              const firstMedia = (<FrigateCardTimelineItem>first).media;
              const secondMedia = (<FrigateCardTimelineItem>second).media;

              // Never include the currently selected item in a cluster, and
              // never group different object types together (e.g. person and
              // car).
              return (
                first.type !== 'background' &&
                first.type === second.type &&
                first.id !== selectedId &&
                second.id !== selectedId &&
                !!firstMedia &&
                !!secondMedia &&
                ViewMediaClassifier.isEvent(firstMedia) &&
                ViewMediaClassifier.isEvent(secondMedia) &&
                firstMedia.isGroupableWith(secondMedia)
              );
            },
          }
        : // Timeline type information is incorrect requiring this 'as'.
          (false as unknown as TimelineOptionsCluster),
      minHeight: '100%',
      maxHeight: '100%',
      zoomMax: 1 * 24 * 60 * 60 * 1000,
      zoomMin: 1 * 1000,
      selectable: true,
      start: defaultWindow.start,
      end: defaultWindow.end,
      groupHeightMode: 'auto',
      tooltip: {
        followMouse: true,
        overflowMethod: 'cap',
        template: this._getTooltip.bind(this),
      },
      xss: {
        disabled: false,
        filterOptions: {
          whiteList: {
            'frigate-card-timeline-thumbnail': ['details', 'item'],
            div: ['title'],
            span: ['style'],
          },
        },
      },
    };
  }

  /**
   * Determine if the component should be updated.
   * @param _changedProps The changed properties.
   * @returns
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected shouldUpdate(_changedProps: PropertyValues): boolean {
    return !!this.hass && !!this.cameras && this.cameras.size > 0;
  }

  /**
   * Update the timeline from the view object.
   */
  protected async _updateTimelineFromView(): Promise<void> {
    if (
      !this.hass ||
      !this.cameras ||
      !this.view ||
      !this.timelineConfig ||
      !this._timelineSource ||
      !this._timeline
    ) {
      return;
    }

    const timelineWindow = this._timeline.getWindow();

    // Calculate the timeline window to show. If there is a window set in the
    // view context, always honor that. Otherwise, if there's a selected media
    // item that is already within the current window (even if it's not
    // perfectly positioned) -- leave it as is. Otherwise, change the window to
    // perfectly center on the media.

    let desiredWindow = timelineWindow;
    const media = this.view.queryResults?.getSelectedResult();
    const mediaStartTime = media?.getStartTime();
    const mediaEndTime = media?.getEndTime();
    const mediaWindow: TimelineWindow | null =
      media && mediaStartTime && mediaEndTime
        ? { start: mediaStartTime, end: mediaEndTime }
        : null;
    const context = this.view.context?.timeline;

    if (context && context.window) {
      desiredWindow = context.window;
    } else if (media && mediaWindow && !rangesOverlap(mediaWindow, timelineWindow)) {
      const perfectMediaWindow = this._getPerfectWindowFromMedia(media);
      if (perfectMediaWindow) {
        desiredWindow = perfectMediaWindow;
      }
    }
    const prefetchedWindow = this._getPrefetchWindow(desiredWindow);

    if (!this._pointerHeld) {
      // Don't fetch any data or touch the timeline in any way if the user is
      // currently interacting with it. Without this the subsequent data fetches
      // (via fetchIfNecessary) may update the timeline contents which causes
      // the visjs timeline to stop dragging/panning operations which is very
      // disruptive to the user.
      await this._timelineSource?.refresh(this.hass, prefetchedWindow);
    }

    const mediaID = media?.getID();
    if (!this._pointerHeld && media && mediaID && this._isClustering()) {
      // Hack: Clustering may not update unless the dataset changes, artifically
      // update the dataset to ensure the newly selected item cannot be included
      // in a cluster. Only do this when the pointer is not held to avoid
      // interrupting the user and to make the timeline smoother.

      // Need to this rewrite prior to setting the selection (just below), or
      // the selection will be lost on rewrite.
      this._timelineSource?.rewriteEvent(mediaID);
    }

    const desiredId =
      !!media && ViewMediaClassifier.isEvent(media) ? media.getID() : null;
    if (desiredId) {
      this._timeline?.setSelection([desiredId], {
        focus: false,
        animation: {
          animation: false,
          zoom: false,
        },
      });
    }

    // Set the timeline window if necessary.
    if (!this._pointerHeld && !isEqual(desiredWindow, timelineWindow)) {
      this._timeline.setWindow(desiredWindow.start, desiredWindow.end);
    }

    // Only generate thumbnails if the existing query is not an acceptable
    // match, to avoid getting stuck in a loop (the subsequent fetches will not
    // actually fetch since the data will have been cached).
    //
    // Timeline receives a new `view`
    //  -> Events fetched
    //    -> Thumbnails generated
    //      -> New view dispatched (to load thumbnails into outer carousel).
    //  -> New view received ... [loop]
    //
    // Also don't generate thumbnails in mini-timelines (they will already have
    // been generated), or if the view is for recordings (media thumbnails are
    // recordings, not events in this case).

    const freshMediaQuery = this._createEventMediaQuerys({
      window: desiredWindow,
    });

    if (
      !this.mini &&
      !MediaQueriesClassifier.areRecordingQueries(this.view.query) &&
      freshMediaQuery &&
      !this._alreadyHasAcceptableMediaQuery(freshMediaQuery)
    ) {
      (await this._createViewWithEventMediaQuery(freshMediaQuery))
        ?.mergeInContext(this._setWindowInContext(desiredWindow))
        .dispatchChangeEvent(this);
    }
  }

  protected _alreadyHasAcceptableMediaQuery(freshMediaQuery: MediaQueries): boolean {
    const currentQueries = this.view?.query?.getQueries();
    const currentResultTimestamp = this.view?.queryResults?.getResultsTimestamp();

    return (
      !!this.cameraManager &&
      !!currentQueries &&
      !!currentResultTimestamp &&
      isEqual(currentQueries, freshMediaQuery.getQueries()) &&
      this.cameraManager.areMediaQueriesResultsFresh<MediaQuery>(
        currentQueries,
        currentResultTimestamp,
      )
    );
  }

  /**
   * Generate the context for timeline views.
   * @returns The TimelineViewContext object.
   */
  protected _setWindowInContext(window?: TimelineWindow): ViewContext {
    const newWindow = window ?? this._timeline?.getWindow();
    return {
      timeline: {
        ...this.view?.context?.timeline,
        ...(newWindow && { window: newWindow }),
      },
    };
  }

  /**
   * Called when an update will occur.
   * @param changedProps The changed properties
   */
  protected willUpdate(changedProps: PropertyValues): void {
    if (changedProps.has('thumbnailSize')) {
      if (this.thumbnailSize !== undefined) {
        this.style.setProperty(
          '--frigate-card-thumbnail-size',
          `${this.thumbnailSize}px`,
        );
      } else {
        this.style.removeProperty('--frigate-card-thumbnail-size');
      }
    }

    if (changedProps.has('timelineConfig')) {
      if (this.timelineConfig?.show_recordings) {
        this.setAttribute('recordings', '');
      } else {
        this.removeAttribute('recordings');
      }
    }

    if (
      changedProps.has('cameraManager') ||
      changedProps.has('cameras') ||
      changedProps.has('timelineConfig') ||
      changedProps.has('cameraIDs')
    ) {
      if (this.cameraManager && this.cameras && this.timelineConfig) {
        this._timelineSource = new TimelineDataSource(
          this.cameraManager,
          this._getTimelineCameraIDs(),
          this.timelineConfig.media,
        );
      } else {
        this._timelineSource = null;
      }
    }
  }

  /**
   * Destroy/reset the timeline.
   */
  protected _destroy(): void {
    this._timeline?.destroy();
    this._timeline = undefined;
    this._targetBarVisible = false;
  }

  /**
   * Called when the component is updated.
   * @param changedProperties The changed properties if any.
   */
  protected updated(changedProperties: PropertyValues): void {
    super.updated(changedProperties);

    if (changedProperties.has('cameras') || changedProperties.has('cameraManager')) {
      this._destroy();
    }

    const options = this._getOptions();
    let createdTimeline = false;

    if (
      this._timelineSource &&
      this._refTimeline.value &&
      options &&
      this.timelineConfig &&
      (changedProperties.has('timelineConfig') || changedProperties.has('cameraIDs'))
    ) {
      if (this._timeline) {
        this._destroy();
      }

      const groups = this._getGroups();
      if (!groups.length) {
        if (!this.mini) {
          // Don't show an empty timeline, show a message instead.
          dispatchMessageEvent(this, localize('error.timeline_no_cameras'), 'info', {
            icon: 'mdi:chart-gantt',
          });
        }
        return;
      }

      createdTimeline = true;
      if (this.mini && groups.length === 1) {
        // In a mini timeline, if there's only one group don't bother grouping
        // at all.
        this._timeline = new Timeline(
          this._refTimeline.value,
          this._timelineSource.dataset,
          options,
        ) as Timeline;
        this.removeAttribute('groups');
      } else {
        this._timeline = new Timeline(
          this._refTimeline.value,
          this._timelineSource.dataset,
          groups,
          options,
        ) as Timeline;
        this.setAttribute('groups', '');
      }

      this._timeline.on('rangechanged', this._timelineRangeChangedHandler.bind(this));
      this._timeline.on('click', this._timelineClickHandler.bind(this));
      this._timeline.on('rangechange', this._timelineRangeChangeHandler.bind(this));

      // This complexity exists to ensure we can tell between a click that
      // causes the timeline zoom/range to change, and a 'static' click on the
      // // timeline (which may need to trigger a card wide event).
      this._timeline.on('mouseDown', (ev: TimelineEventPropertiesResult) => {
        const window = this._timeline?.getWindow();
        this._pointerHeld = {
          ...ev,
          ...(window && { window: window }),
        };
        this._ignoreClick = false;
      });
      this._timeline.on('mouseUp', () => {
        this._pointerHeld = null;
        this._removeTargetBar();
      });
    }

    if (changedProperties.has('view')) {
      if (createdTimeline) {
        // If the timeline was just created, give it one frame to draw itself.
        // Failure to do so may result in subsequent calls to
        // `this._timeline.setwindow()` being entirely ignored. Example case:
        // Clicking the timeline control on a recording thumbnail.
        window.requestAnimationFrame(this._updateTimelineFromView.bind(this));
      } else {
        this._updateTimelineFromView();
      }
    }
  }

  /**
   * Return compiled CSS styles.
   */
  static get styles(): CSSResultGroup {
    return unsafeCSS(timelineCoreStyle);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'frigate-card-timeline-thumbnail': FrigateCardTimelineThumbnail;
    'frigate-card-timeline-core': FrigateCardTimelineCore;
  }
}
