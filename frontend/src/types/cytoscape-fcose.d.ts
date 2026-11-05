/**
 * `cytoscape-fcose` 没有自带类型声明，这里补一个最小声明。
 *
 * fcose 是 cytoscape 官方维护的力导向布局扩展（MIT），
 * 形态就是标准的 cytoscape 扩展（`cytoscape.Ext`）。
 */
declare module "cytoscape-fcose" {
  import type cytoscape from "cytoscape";

  const fcose: cytoscape.Ext;
  export default fcose;
}
