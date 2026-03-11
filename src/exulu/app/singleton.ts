// Singleton instance of the ExuluApp class
// that gets set when the ExuluApp.create is
// called.

import { ExuluApp } from "./index";

let instance: ExuluApp | null = null;

export const exuluApp = {
    get: () => {
        if (!instance) {
            throw new Error("ExuluApp not initialized");
        }
        return instance;
    },
    set: (app: ExuluApp) => {
        instance = app;
    }
}