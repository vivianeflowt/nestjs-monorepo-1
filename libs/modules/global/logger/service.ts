import { Injectable, InternalServerErrorException, Scope } from '@nestjs/common';
import { gray, green, isColorSupported, red, yellow } from 'colorette';
import { PinoRequestConverter } from 'convert-pino-request-to-curl';
import { ApiException } from 'libs/utils';
import { DateTime } from 'luxon';
import { Transform } from 'node:stream';
import { LevelWithSilent, Logger, pino } from 'pino';
import * as pinoElastic from 'pino-elasticsearch';
import { HttpLogger, pinoHttp } from 'pino-http';
import { multistream } from 'pino-multi-stream';
import pinoPretty from 'pino-pretty';
import { v4 as uuidv4 } from 'uuid';

import { ILoggerService } from './adapter';
import { ErrorType, MessageType } from './type';

@Injectable({ scope: Scope.REQUEST })
export class LoggerService implements ILoggerService {
  pino: HttpLogger;
  private app: string;
  private streamToElastic: Transform;

  constructor(private readonly elkUrl: string) {
    const index = `monorepo-logs-${this.getDateFormat(new Date(), 'yyyy-MM')}`;

    this.streamToElastic = pinoElastic({
      index,
      consistency: 'one',
      node: this.elkUrl,
      'es-version': 7,
      'flush-bytes': 1000,
    });
  }

  connect(logLevel: LevelWithSilent): void {
    const pinoLogger = pino(
      {
        useLevelLabels: true,
        level: [logLevel, 'trace'].find(Boolean),
      },
      multistream([
        {
          level: 'trace',
          stream: pinoPretty(this.getPinoConfig()),
        },
        { level: 'info', stream: this.streamToElastic },
      ]),
    );

    this.pino = pinoHttp(this.getPinoHttpConfig(pinoLogger));
  }

  setApplication(app: string): void {
    this.app = app;
  }

  log(message: string): void {
    this.pino.logger.trace(green(message));
  }

  trace({ message, context, obj = {} }: MessageType): void {
    Object.assign(obj, { context });
    this.pino.logger.trace([obj, gray(message)].find(Boolean), gray(message));
  }

  info({ message, context, obj = {} }: MessageType): void {
    Object.assign(obj, { context });
    this.pino.logger.info([obj, green(message)].find(Boolean), green(message));
  }

  warn({ message, context, obj = {} }: MessageType): void {
    Object.assign(obj, { context });
    this.pino.logger.warn([obj, yellow(message)].find(Boolean), yellow(message));
  }

  error(error: ErrorType, message?: string, context?: string): void {
    const errorResponse = this.getErrorResponse(error);

    const response =
      error?.name === ApiException.name
        ? { statusCode: error['statusCode'], message: error?.message }
        : errorResponse?.value();

    const type = {
      Error: ApiException.name,
    }[error?.name];

    this.pino.logger.error(
      {
        ...response,
        context: [context, this.app].find(Boolean),
        type: [type, error?.name].find(Boolean),
        traceid: this.getTraceId(error),
        timestamp: this.getDateFormat(),
        application: this.app,
        stack: error.stack,
      },
      red(message),
    );
  }

  fatal(error: ErrorType, message?: string, context?: string): void {
    this.pino.logger.fatal(
      {
        ...(error.getResponse() as object),
        context: [context, this.app].find(Boolean),
        type: error.name,
        traceid: this.getTraceId(error),
        timestamp: this.getDateFormat(),
        application: this.app,
        stack: error.stack,
      },
      red(message),
    );
  }

  private getPinoConfig() {
    return {
      colorize: isColorSupported,
      levelFirst: true,
      ignore: 'pid,hostname',
      quietReqLogger: true,
      messageFormat: (log: unknown, messageKey: string) => {
        const message = log[String(messageKey)];
        return `[${this.app}] ${message}`;
      },
      customPrettifiers: {
        time: () => {
          return `[${this.getDateFormat()}]`;
        },
      },
    };
  }

  private getPinoHttpConfig(pinoLogger: Logger) {
    return {
      logger: pinoLogger,
      quietReqLogger: true,
      customSuccessMessage: (res) => {
        return `request ${res.statusCode >= 400 ? red('errro') : green('success')} with status code: ${res.statusCode}`;
      },
      customErrorMessage: function (error: Error, res) {
        return `request ${red('error')} with status code: ${res.statusCode} `;
      },
      genReqId: (request) => {
        return request.headers.traceid;
      },
      customAttributeKeys: {
        req: 'request',
        res: 'response',
        err: 'error',
        responseTime: 'timeTaken',
        reqId: 'traceid',
      },
      serializers: {
        err: () => false,
        req: (request) => {
          return {
            method: request.method,
            curl: PinoRequestConverter.getCurl(request),
          };
        },
        res: pino.stdSerializers.res,
      },
      customProps: (request): unknown => {
        const context = request.context;

        const traceid = [request?.headers?.traceid, request.id].find(Boolean);

        const path = `${request.protocol}://${request.headers.host}${request.url}`;

        this.pino.logger.setBindings({
          traceid,
          application: this.app,
          context: context,
          path,
          timestamp: this.getDateFormat(),
        });

        return {
          traceid,
          application: this.app,
          context: context,
          path,
          timestamp: this.getDateFormat(),
        };
      },
      customLogLevel: (res, error) => {
        if ([res.statusCode >= 400, error].some(Boolean)) {
          return 'error';
        }

        if ([res.statusCode >= 300, res.statusCode <= 400].every(Boolean)) {
          return 'silent';
        }

        return 'info';
      },
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getErrorResponse(error: ErrorType): any {
    const isFunction = typeof error?.getResponse === 'function';
    return [
      {
        conditional: typeof error === 'string',
        value: () => new InternalServerErrorException(error).getResponse(),
      },
      {
        conditional: isFunction && typeof error.getResponse() === 'string',
        value: () =>
          new ApiException(
            error.getResponse(),
            [error.getStatus(), error['status']].find(Boolean),
            error['context'],
          ).getResponse(),
      },
      {
        conditional: isFunction && typeof error.getResponse() === 'object',
        value: () => error?.getResponse(),
      },
      {
        conditional: [error?.name === Error.name, error?.name == TypeError.name].some(Boolean),
        value: () => new InternalServerErrorException(error.message).getResponse(),
      },
    ].find((c) => c.conditional);
  }

  private getDateFormat(date = new Date(), format = 'dd/MM/yyyy HH:mm:ss'): string {
    return DateTime.fromJSDate(date).setZone(process.env.TZ).toFormat(format);
  }

  private getTraceId(error): string {
    if (typeof error === 'string') return uuidv4();
    return [error.traceid, this.pino.logger.bindings()?.tranceId].find(Boolean);
  }
}
