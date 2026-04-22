import { Router, type IRouter } from "express";
import healthRouter from "./health";
import lectureRouter from "./lecture";

const router: IRouter = Router();

router.use(healthRouter);
router.use(lectureRouter);

export default router;
