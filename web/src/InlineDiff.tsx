import { useMemo, useState } from "react";
import { diffContext, diffLines } from "./line-diff";
import "./inline-diff.css";

export default function InlineDiff({ before, after }: { before: string; after: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  if (before === after) return <p className="inline-diff-empty">正文没有变化。</p>;
  const visible = expanded ? lines : diffContext(lines);
  return (
    <section className="inline-diff" aria-label="草稿修改对比">
      <div className="inline-diff-legend"><span>− 删除</span><span>+ 新增</span>
        {lines.some(line => line.kind === "same") && <button type="button" onClick={() => setExpanded(!expanded)}>{expanded ? "收起未改内容" : "展开完整内容"}</button>}
      </div>
      <div className="inline-diff-lines">
        {visible.map((line, index) => line.kind === "omitted"
          ? <div className="inline-diff-omitted" key={index}>省略 {line.count} 行未改内容</div>
          : <div className={`inline-diff-line inline-diff-${line.kind}`} key={index}>
              <span className="inline-diff-marker" aria-label={line.kind === "added" ? "新增" : line.kind === "removed" ? "删除" : "未改"}>{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</span>
              <span className="inline-diff-text">{line.text || "\u00a0"}</span>
            </div>)}
      </div>
    </section>
  );
}
