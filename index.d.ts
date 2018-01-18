import {Request, RequestHandler, Response} from 'express';
import {ZlibOptions} from 'zlib';
import {BrotliEncodeParams} from 'iltorb';

type FilterFunction = (req: Request, res: Response) => boolean;

interface ShrinkRayOptions {
  brotli?: Partial<BrotliEncodeParams>;
  cacheSize?: number | string | false;
  filter?: FilterFunction;
  threshold?: number | string | false;
  zlib?: Partial<ZlibOptions>;

  cache?(req: Request, res: Response): boolean;
}


interface CreateMiddleware {
  (options?: ShrinkRayOptions): RequestHandler;

  filter: FilterFunction;
}

declare const createMiddleware: CreateMiddleware;

export = createMiddleware;
