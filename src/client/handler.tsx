import {
  AsyncSeriesHook,
  AsyncParallelBailHook,
  SyncHook,
} from 'tapable';
import invert from 'lodash/invert';
import React from 'react';
import { renderRoutes } from 'react-router-config';
import { Router } from 'react-router';
import { HashRouter } from 'react-router-dom';
import { createBrowserHistory } from 'history';
import { render, hydrate } from 'react-dom';
import get from 'lodash/get';
import RouteHandler from '../router/handler';
import ErrorBoundary from '../components/ErrorBoundary';
import { generateMeta } from '../utils/seo';
import possibleStandardNames from '../utils/reactPossibleStandardNames';
import AbstractPlugin from '../abstract-plugin';

const possibleHtmlNames = invert(possibleStandardNames);
const getPossibleHtmlName = (key: string) => possibleHtmlNames[key] || key;

type HistoryLocation = {
  pathname: string;
  search?: string;
  hash?: string;
  key?: string;
  state?: any;
};

const b64DecodeUnicode = (str: string) => decodeURIComponent(
  atob(str)
    .split('')
    .map(c => `%${(`00${c.charCodeAt(0).toString(16)}`).slice(-2)}`)
    .join(''),
);

export default class ClientHandler extends AbstractPlugin {
  historyUnlistener = null;

  routeHandler: RouteHandler | null = null;

  history: any;

  hooks: {
    beforeRender: AsyncSeriesHook<any>;
    locationChange: AsyncParallelBailHook<any, any>;
    beforeLoadData: AsyncSeriesHook<any>;
    renderRoutes: AsyncSeriesHook<any>;
    renderComplete: SyncHook<any, any>;
  };

  options: {
    env: any;
  };

  constructor(options: { env: any; }) {
    super();
    this.addPlugin = this.addPlugin.bind(this);
    this.manageHistoryChange = this.manageHistoryChange.bind(this);

    window.PAW_HISTORY = window.PAW_HISTORY || createBrowserHistory({
      basename: options.env.appRootUrl,
    });
    this.history = window.PAW_HISTORY;
    this.historyUnlistener = this.history.listen(this.manageHistoryChange);

    this.hooks = {
      locationChange: new AsyncParallelBailHook(['location', 'action']),
      beforeLoadData: new AsyncSeriesHook(['setParams', 'getParams']),
      beforeRender: new AsyncSeriesHook(['Application']),
      renderRoutes: new AsyncSeriesHook(['AppRoutes']),
      renderComplete: new SyncHook(),
    };
    this.options = options;
    this.manageServiceWorker();
  }

  manageHistoryChange(location: HistoryLocation, action: string) {
    this.hooks.locationChange.callAsync(location, action, () => null);
    if (this.routeHandler) {
      this.updatePageMeta(location).catch((e) => {
        // eslint-disable-next-line
        console.log(e);
      });
    }
  }

  async updatePageMeta(location: HistoryLocation) {
    if (!this.routeHandler) return null;
    const routes = this.routeHandler.getRoutes();
    const currentRoutes = RouteHandler.matchRoutes(
      routes,
      location.pathname.replace(this.options.env.appRootUrl, ''),
    );
    const promises: Promise<any> [] = [];

    let seoData = {};
    const pwaSchema = this.routeHandler.getPwaSchema();
    const seoSchema = this.routeHandler.getDefaultSeoSchema();

    // Wait for preload data manager to get executed
    await new Promise(r => this
      .hooks
      .beforeLoadData
      .callAsync(
        this.routeHandler.routeCompiler.preloadManager.setParams,
        this.routeHandler.routeCompiler.preloadManager.getParams,
        r,
      ));

    currentRoutes.forEach((r) => {
      if (r.route && r.route.component && r.route.component.preload) {
        promises.push(r.route.component.preload(undefined, {
          route: r.route,
          match: r.match,
        }));
      }
    });

    await Promise.all(promises).then(() => {
      currentRoutes.forEach((r) => {
        let routeSeo = {};
        if (r.route.getRouteSeo) {
          routeSeo = r.route.getRouteSeo();
        }
        seoData = { ...seoData, ...r.route.seo, ...routeSeo };
      });

      const metaTags = generateMeta(seoData, {
        baseUrl: window.location.origin,
        url: window.location.href,
        seoSchema,
        pwaSchema,
      });

      metaTags.forEach((meta) => {
        let metaSearchStr = 'meta';
        let firstMetaSearchStr = '';
        const htmlMeta = {};

        if (meta.name === 'title') {
          document.title = meta.content;
        }

        Object.keys(meta).forEach((key) => {
          htmlMeta[getPossibleHtmlName(key)] = meta[key];
          if (!firstMetaSearchStr) {
            firstMetaSearchStr = `meta[${getPossibleHtmlName(key)}=${JSON.stringify(meta[key])}]`;
          }
          metaSearchStr += `[${getPossibleHtmlName(key)}=${JSON.stringify(meta[key])}]`;
        });

        const alreadyExists = document.querySelector(metaSearchStr);
        if (!alreadyExists) {
          const previousExists = document.querySelector(firstMetaSearchStr);
          if (previousExists && previousExists.remove) {
            previousExists.remove();
          }

          const metaElement = document.createElement('meta');
          Object.keys(htmlMeta).forEach((htmlMetaKey) => {
            metaElement.setAttribute(htmlMetaKey, htmlMeta[htmlMetaKey]);
          });
          document.getElementsByTagName('head')[0].appendChild(metaElement);
        }
      });
    });
  }

  manageServiceWorker()   {
    if (this.options.env.serviceWorker) {
      this.hooks.renderComplete.tap('AddServiceWorker', (err) => {
        if (err) return;
        if ('serviceWorker' in navigator) {
          navigator.serviceWorker.register(
            `${this.options.env.appRootUrl}/sw.js`,
          ).catch(() => null);
        }
      });
    } else {
      // remove previously registered service worker
      this.hooks.renderComplete.tap('RemoveServiceWorker', (err) => {
        if (err) return;
        if ('serviceWorker' in navigator) {
          navigator.serviceWorker.getRegistrations().then((registrations) => {
            registrations.forEach(registration => registration.unregister());
          });
        }
      });
    }
  }

  async run({ routeHandler }: { routeHandler: RouteHandler }) {
    this.routeHandler = routeHandler;
    const { env } = this.options;
    const root = get(env, 'clientRootElementId', 'app');

    if (!document.getElementById(root)) {
      // eslint-disable-next-line
      console.warn(`#${root} element not found in html. thus cannot proceed further`);
      return false;
    }
    const domRootReference = document.getElementById(root);
    const renderer = env.serverSideRender && !env.singlePageApplication ? hydrate : render;

    const routes = routeHandler.getRoutes();
    const currentPageRoutes = RouteHandler.matchRoutes(
      routes,
      window.location.pathname.replace(
        this.options.env.appRootUrl,
        '',
      ),
    );

    const promises: Promise<any> [] = [];

    // Wait for preload data manager to get executed
    await new Promise(r => this
      .hooks
      .beforeLoadData
      .callAsync(
        this.routeHandler.routeCompiler.preloadManager.setParams,
        this.routeHandler.routeCompiler.preloadManager.getParams,
        r,
      ));


    console.log('after this');
    if (window.PAW_PRELOADED_DATA) {
      const preloadedData = JSON.parse(b64DecodeUnicode(window.PAW_PRELOADED_DATA));
      currentPageRoutes.forEach((r, i) => {
        if (
          (typeof preloadedData[i] !== 'undefined')
          && r.route && r.route.component && r.route.component.preload
        ) {
          const preloadInit = r.route.component.preload(preloadedData[i], {
            route: r.route,
            match: r.match,
          });
          promises.push(preloadInit.promise);
        }
      });
    }
    await Promise.all(promises);

    const AppRouter = (this.options.env.singlePageApplication && this.options.env.hashedRoutes)
      ? HashRouter : Router;

    let RouterParams = {
      history: this.history,
    };
    if (this.options.env.singlePageApplication && this.options.env.hashedRoutes) {
      RouterParams = {};
    }

    const AppRoutes = {
      renderedRoutes: renderRoutes(routes),
      setRenderedRoutes: (r) => {
        AppRoutes.renderedRoutes = r;
      },
      getRenderedRoutes: () => AppRoutes.renderedRoutes,
    };

    await (new Promise(r => this.hooks.renderRoutes.callAsync({
      setRenderedRoutes: AppRoutes.setRenderedRoutes,
      getRenderedRoutes: AppRoutes.getRenderedRoutes,
    }, r)));

    // await this.hooks.renderRoutes.callAsync({
    //   setRenderedRoutes: AppRoutes.setRenderedRoutes,
    //   getRenderedRoutes: AppRoutes.getRenderedRoutes,
    // }, () => null);
    const children = (
      // eslint-disable-next-line react/jsx-props-no-spreading
      <AppRouter basename={env.appRootUrl} {...RouterParams}>
        {AppRoutes.renderedRoutes}
      </AppRouter>
    );
    const Application = {
      children,
      currentRoutes: currentPageRoutes.slice(0),
      routes: routes.slice(0),
    };

    return new Promise((resolve) => {
      this.hooks.beforeRender.callAsync(Application, async () => {
        console.log('pre-render');
        // Render according to routes!
        renderer(
          <ErrorBoundary ErrorComponent={routeHandler.getErrorComponent()}>
            {Application.children}
          </ErrorBoundary>,
          domRootReference,
          // div,
          () => {
            window.PAW_PRELOADED_DATA = null;
            delete window.PAW_PRELOADED_DATA;
            if (document.getElementById('__pawjs_preloaded') && document.getElementById('__pawjs_preloaded').remove) {
              document.getElementById('__pawjs_preloaded').remove();
            }
            this.hooks.renderComplete.call();
            resolve();
          },
        );
      });
    });
  }
}