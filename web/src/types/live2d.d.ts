declare module 'pixi.js' {
  export class Application {
    constructor(options?: Record<string, unknown>);
    stage: { addChild(child: unknown): void };
    destroy(removeView?: boolean): void;
  }
  const _default: typeof import('pixi.js');
  export default _default;
}

declare module 'pixi-live2d-display' {
  export class Live2DModel {
    static from(
      url: string,
      options?: Record<string, unknown>,
    ): Promise<Live2DModel>;
    width: number;
    height: number;
    x: number;
    y: number;
    scale: { set(x: number, y?: number): void };
    anchor: { set(x: number, y: number): void };
    internalModel?: {
      motionManager?: {
        definitions: Record<string, unknown[]>;
        startMotion(group: string, index: number, priority?: number): void;
      };
    };
  }
}
