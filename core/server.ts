import express from "express";
import { type Request, type Response} from "express";
import {exulu} from "./exulu.ts";
const bodyParser = require('body-parser');
import cors from "cors";

const expressApp = express();
const port = 9001;
expressApp.use(bodyParser.json());
expressApp.use(cors())

await exulu.server.express.init(expressApp)

expressApp.get("/", (req: Request, res: Response) => {
    res.status(200).json({
        message: "Hello, welcome to the Exulu backend ❤️."
    })
    return;
});

expressApp.listen(port, () => {
    console.log(`Exulu is listening on port ${port}.`);
});