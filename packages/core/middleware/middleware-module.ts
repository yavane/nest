import { NestContainer } from '../injector/container';
import { MiddlewareBuilder } from './builder';
import { MiddlewareContainer, MiddlewareWrapper } from './container';
import { MiddlewareResolver } from './resolver';
import { ControllerMetadata } from '@nestjs/common/interfaces/controllers/controller-metadata.interface';
import { NestModule } from '@nestjs/common/interfaces/modules/nest-module.interface';
import { MiddlewareConfiguration } from '@nestjs/common/interfaces/middleware/middleware-configuration.interface';
import { InvalidMiddlewareException } from '../errors/exceptions/invalid-middleware.exception';
import { RequestMethod } from '@nestjs/common/enums/request-method.enum';
import { RoutesMapper } from './routes-mapper';
import { RouterProxy } from '../router/router-proxy';
import { ExceptionsHandler } from '../exceptions/exceptions-handler';
import { Module } from '../injector/module';
import { RouterMethodFactory } from '../helpers/router-method-factory';
import { NestMiddleware } from '@nestjs/common/interfaces/middleware/nest-middleware.interface';
import { Type } from '@nestjs/common/interfaces/type.interface';
import { RuntimeException } from '../errors/exceptions/runtime.exception';
import { isUndefined } from '@nestjs/common/utils/shared.utils';
import { ApplicationConfig } from '../application-config';
import { RouterExceptionFilters } from '../router/router-exception-filters';

export class MiddlewareModule {
  private readonly routerProxy = new RouterProxy();
  private readonly routerMethodFactory = new RouterMethodFactory();
  private routerExceptionFilter: RouterExceptionFilters;
  private routesMapper: RoutesMapper;
  private resolver: MiddlewareResolver;

  public async register(
    middlewareContainer: MiddlewareContainer,
    container: NestContainer,
    config: ApplicationConfig,
  ) {
    const appRef = container.getApplicationRef();
    this.routerExceptionFilter = new RouterExceptionFilters(
      container,
      config,
      appRef,
    );
    this.routesMapper = new RoutesMapper(container);
    this.resolver = new MiddlewareResolver(middlewareContainer);

    const modules = container.getModules();
    await this.resolveMiddleware(middlewareContainer, modules);
  }

  public async resolveMiddleware(
    middlewareContainer: MiddlewareContainer,
    modules: Map<string, Module>,
  ) {
    await Promise.all(
      [...modules.entries()].map(async ([name, module]) => {
        const instance = module.instance;

        this.loadConfiguration(middlewareContainer, instance, name);
        await this.resolver.resolveInstances(module, name);
      }),
    );
  }

  public loadConfiguration(
    middlewareContainer: MiddlewareContainer,
    instance: NestModule,
    module: string,
  ) {
    if (!instance.configure) return;

    const middlewareBuilder = new MiddlewareBuilder(this.routesMapper);
    instance.configure(middlewareBuilder);

    if (!(middlewareBuilder instanceof MiddlewareBuilder)) return;

    const config = middlewareBuilder.build();
    middlewareContainer.addConfig(config, module);
  }

  public async registerMiddleware(
    middlewareContainer: MiddlewareContainer,
    applicationRef: any,
  ) {
    const configs = middlewareContainer.getConfigs();
    const registerAllConfigs = (
      module: string,
      middlewareConfig: MiddlewareConfiguration[],
    ) =>
      middlewareConfig.map(async (config: MiddlewareConfiguration) => {
        await this.registerMiddlewareConfig(
          middlewareContainer,
          config,
          module,
          applicationRef,
        );
      });

    await Promise.all(
      [...configs.entries()].map(async ([module, moduleConfigs]) => {
        await Promise.all(registerAllConfigs(module, [...moduleConfigs]));
      }),
    );
  }

  public async registerMiddlewareConfig(
    middlewareContainer: MiddlewareContainer,
    config: MiddlewareConfiguration,
    module: string,
    applicationRef: any,
  ) {
    const { forRoutes } = config;
    await Promise.all(
      forRoutes.map(async (routePath: string) => {
        await this.registerRouteMiddleware(
          middlewareContainer,
          routePath,
          config,
          module,
          applicationRef,
        );
      }),
    );
  }

  public async registerRouteMiddleware(
    middlewareContainer: MiddlewareContainer,
    routePath: string,
    config: MiddlewareConfiguration,
    module: string,
    applicationRef: any,
  ) {
    const middlewareCollection = [].concat(config.middleware);
    await Promise.all(
      middlewareCollection.map(async (metatype: Type<NestMiddleware>) => {
        const collection = middlewareContainer.getMiddleware(module);
        const middleware = collection.get(metatype.name);
        if (isUndefined(middleware)) {
          throw new RuntimeException();
        }

        const { instance } = middleware as MiddlewareWrapper;
        await this.bindHandler(
          instance,
          metatype,
          applicationRef,
          RequestMethod.ALL,
          routePath,
        );
      }),
    );
  }

  private async bindHandler(
    instance: NestMiddleware,
    metatype: Type<NestMiddleware>,
    applicationRef: any,
    method: RequestMethod,
    path: string,
  ) {
    if (isUndefined(instance.resolve)) {
      throw new InvalidMiddlewareException(metatype.name);
    }
    const exceptionsHandler = this.routerExceptionFilter.create(
      instance,
      instance.resolve,
      undefined,
    );
    const router = this.routerMethodFactory
      .get(applicationRef, method)
      .bind(applicationRef);

    const bindWithProxy = obj =>
      this.bindHandlerWithProxy(exceptionsHandler, router, obj, path);
    const resolve = instance.resolve();
    if (!(resolve instanceof Promise)) {
      bindWithProxy(resolve);
      return;
    }
    const middleware = await resolve;
    bindWithProxy(middleware);
  }

  private bindHandlerWithProxy(
    exceptionsHandler: ExceptionsHandler,
    router: (...args) => void,
    middleware: (req, res, next) => void,
    path: string,
  ) {
    const proxy = this.routerProxy.createProxy(middleware, exceptionsHandler);
    router(path, proxy);
  }
}
