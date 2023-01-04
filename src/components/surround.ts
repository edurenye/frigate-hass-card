import {
  CSSResultGroup,
  html,
  LitElement,
  PropertyValues,
  TemplateResult,
  unsafeCSS,
} from 'lit';
import { customElement, property } from 'lit/decorators.js';
import surroundStyle from '../scss/surround.scss';
import {
  CameraConfig,
  ClipsOrSnapshotsOrAll,
  ExtendedHomeAssistant,
  MiniTimelineControlConfig,
  ThumbnailsControlConfig,
} from '../types.js';
import { contentsChanged, dispatchFrigateCardEvent } from '../utils/basic.js';
import { CameraManager } from '../camera/manager.js';
import { View } from '../view/view.js';
import { ThumbnailCarouselTap } from './thumbnail-carousel.js';
import './surround-basic.js';
import { changeViewToRecentEventsForCameraAndDependents } from '../utils/media-to-view';

interface ThumbnailViewContext {
  // Whether or not to fetch thumbnails.
  fetch?: boolean;
}

declare module 'view' {
  interface ViewContext {
    thumbnails?: ThumbnailViewContext;
  }
}

@customElement('frigate-card-surround')
export class FrigateCardSurround extends LitElement {
  @property({ attribute: false })
  public hass?: ExtendedHomeAssistant;

  @property({ attribute: false })
  public view?: Readonly<View>;

  @property({ attribute: false, hasChanged: contentsChanged })
  public thumbnailConfig?: ThumbnailsControlConfig;

  @property({ attribute: false, hasChanged: contentsChanged })
  public timelineConfig?: MiniTimelineControlConfig;

  @property({ attribute: false })
  public inBackground?: boolean;

  // If fetchMedia is not specified, no fetching is done.
  @property({ attribute: false, hasChanged: contentsChanged })
  public fetchMedia?: ClipsOrSnapshotsOrAll;

  @property({ attribute: false })
  public cameras?: Map<string, CameraConfig>;

  @property({ attribute: false })
  public cameraManager?: CameraManager;

  /**
   * Fetch thumbnail media when a target is not specified in the view (e.g. for
   * the live view).
   * @param param Task parameters.
   * @returns
   */
  protected async _fetchMedia(): Promise<void> {
    if (
      !this.cameras ||
      !this.cameraManager ||
      !this.fetchMedia ||
      this.inBackground ||
      !this.hass ||
      !this.view ||
      this.view.query ||
      !this.thumbnailConfig ||
      this.thumbnailConfig.mode === 'none' ||
      !(this.view.context?.thumbnails?.fetch ?? true)
    ) {
      return;
    }
    await changeViewToRecentEventsForCameraAndDependents(
      this,
      this.hass,
      this.cameraManager,
      this.cameras,
      this.view,
      {
        mediaType: this.fetchMedia,
      },
    );
  }

  /**
   * Determine if a drawer is being used.
   * @returns `true` if a drawer is used, `false` otherwise.
   */
  protected _hasDrawer(): boolean {
    return (
      !!this.thumbnailConfig && ['left', 'right'].includes(this.thumbnailConfig.mode)
    );
  }

  /**
   * Called before each update.
   */
  protected willUpdate(changedProperties: PropertyValues): void {
    if (this.timelineConfig?.mode && this.timelineConfig.mode !== 'none') {
      import('./timeline.js');
    }

    // Once the component will certainly update, dispatch a media request. Only
    // do so if properties relevant to the request have changed (as per their
    // hasChanged).
    if (
      ['view', 'fetch', 'browseMediaParams', 'inBackground'].some((prop) =>
        changedProperties.has(prop),
      )
    ) {
      this._fetchMedia();
    }
  }

  /**
   * Master render method.
   * @returns A rendered template.
   */
  protected render(): TemplateResult | void {
    if (!this.hass || !this.view || !this.thumbnailConfig) {
      return;
    }

    const changeDrawer = (ev: CustomEvent, action: 'open' | 'close') => {
      // The event catch/re-dispatch below protect encapsulation: Catches the
      // request to view thumbnails and re-dispatches a request to open the drawer
      // (if the thumbnails are in a drawer). The new event needs to be dispatched
      // from the origin of the inbound event, so it can be handled by
      // <frigate-card-surround> .
      if (this.thumbnailConfig && this._hasDrawer()) {
        dispatchFrigateCardEvent(ev.composedPath()[0], 'drawer:' + action, {
          drawer: this.thumbnailConfig.mode,
        });
      }
    };

    return html` <frigate-card-surround-basic
      @frigate-card:thumbnails:open=${(ev: CustomEvent) => changeDrawer(ev, 'open')}
      @frigate-card:thumbnails:close=${(ev: CustomEvent) => changeDrawer(ev, 'close')}
    >
      ${this.thumbnailConfig &&
      this.thumbnailConfig.mode !== 'none' &&
      !this.inBackground
        ? html` <frigate-card-thumbnail-carousel
            slot=${this.thumbnailConfig.mode}
            .hass=${this.hass}
            .config=${this.thumbnailConfig}
            .cameraManager=${this.cameraManager}
            .view=${this.view}
            .cameras=${this.cameras}
            .selected=${this.view.queryResults?.getSelectedIndex() ?? undefined}
            @frigate-card:view:change=${(ev: CustomEvent) => changeDrawer(ev, 'close')}
            @frigate-card:thumbnail-carousel:tap=${(
              ev: CustomEvent<ThumbnailCarouselTap>,
            ) => {
              const media = ev.detail.queryResults.getSelectedResult();
              if (media) {
                this.view
                  ?.evolve({
                    view: 'media',
                    queryResults: ev.detail.queryResults,
                    ...(media.getCameraID() && { camera: media.getCameraID() }),
                  })
                  .removeContext('timeline')
                  // Send the view change from the source of the tap event, so
                  // the view change will be caught by the handler above (to
                  // close the drawer).
                  .dispatchChangeEvent(ev.composedPath()[0]);
              }
            }}
          >
          </frigate-card-thumbnail-carousel>`
        : ''}
      ${this.timelineConfig?.mode &&
      this.timelineConfig.mode !== 'none' &&
      !this.inBackground
        ? html` <frigate-card-timeline-core
            slot=${this.timelineConfig.mode}
            .hass=${this.hass}
            .view=${this.view}
            .cameras=${this.cameras}
            .mini=${true}
            .timelineConfig=${this.timelineConfig}
            .thumbnailDetails=${this.thumbnailConfig?.show_details}
            .thumbnailSize=${this.thumbnailConfig?.size}
            .cameraManager=${this.cameraManager}
          >
          </frigate-card-timeline-core>`
        : ''}
      <slot></slot>
    </frigate-card-surround-basic>`;
  }

  /**
   * Return compiled CSS styles.
   */
  static get styles(): CSSResultGroup {
    return unsafeCSS(surroundStyle);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'frigate-card-surround': FrigateCardSurround;
  }
}
