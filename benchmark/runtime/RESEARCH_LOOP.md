# Research stages and execution evidence

The heartbeat runtime's explicit `research_loop=True` option retains the
original research objective while separating an initial-candidate Todo from
its deferred research successor. Omission preserves the previous treatment.
The runtime selects the existing `evidence_conditioned_v1` replan strategy and
rejects an explicitly conflicting strategy. This standalone stage/evidence
entry retains the existing Host admission boundaries; it does not install a
per-provider-request guard. When composed with C1's native request-admission
entry, that entry checks ordinary Host admission at each actual provider send
and requires a configured Responses-compatible endpoint.

The entry creates the two stages using existing `todo_done` and successor
semantics. Finishing the candidate releases real optimization work; it cannot
by itself close that work. Research retains the best candidate, meaningful
negative results and reasoned closeout against the original objective. User
Stop, the original budget and genuine blockers remain authoritative.
Preparation records scope through the ordinary Agent Vision writer as
`surface_only`, without claiming research progress or spending a work Turn.
Existing research work is not reopened or its later Vision overwritten.

The installed `loopx-research-probe` uses the staged runner/Python. The same
producer can be called as `python -m benchmark.runtime.research_probe`:

```sh
loopx-research-probe --candidate-file candidate.py --output probe-001.json \
  --input-revision public-case-v1 --planned-method-id scheduler \
  --executed-method-id mask-selection --change-reason 'The control isolated mask selection first.' \
  --evidence-ref probe:local-001 --limit-seconds 30 --diagnostics probe-diagnostics.json \
  -- python3 candidate.py
```

The solver may write `{"search_iterations":2,"stop_reason":"search_cap"}` to
`LOOPX_RESEARCH_DIAGNOSTICS`. The host measures elapsed time, exit/timeout and
the selected candidate-file digest before/after. A changed candidate rejects
attribution. Solver counters and reasons remain reports; missing counters
remain null. Low resource use does not impose a mandatory time floor.
Malformed optional diagnostics preserve reliable host measurements and retain
a bounded diagnostic-error receipt. Evidence paths must be fresh; raw output
stays local. The probe neither submits nor accesses hidden evaluation.

The adjacent `.candidate.json` preserves selected relative paths and hashes.
`candidate_sha256` hashes the sorted JSON file manifest, not native archive
container bytes. Pins cover only declared files at the probe boundaries, not
transitive imports or independent writers. Result attribution must still prove
that the evaluated snapshot matches the selected candidate and input revision.

Attach the emitted `execution_observation` through normal Explore result
writeback. Its input revision and evidence refs must belong to the enclosing
finding; released results must identify the candidate actually evaluated.
Different planned/executed method ids require a change reason. Findings,
replan and research-history details retain this same source. They do not
certify method benefit or Goal completion. Missing observations preserve old
events; a reader for the optional field is required for new retained findings.

Result followthrough uses existing material delivery classifications.
`surface_only` and unknown historical outcomes remain readable but cannot
consume a cited work result or create a new unresolved experiment. Useful
negative results and concrete blockers remain eligible evidence.

## 中文交付边界

显式研究入口保留原 Goal，把初始候选与后续研究表示成既有 Todo 和后继依赖。
候选完成只释放后续研究，准备阶段使用 `surface_only`，不会声称已经取得收益。
Stop、原预算和真实阻塞保持有效，不要求填满时长或改变原生评测规则。
独立的阶段/证据入口沿用既有 Host 准入边界，不安装逐次 provider 请求守卫。
只有组合 C1 的原生请求准入入口后，该入口才会在每次实际 provider 发送前检查
普通 Host 准入，并要求配置兼容 Responses 的端点。

本地探针固定所选文件，记录真实耗时、退出与超时状态；可选 solver 报告与宿主
测量分开，坏诊断不能抹去可靠测量。所选文件清单哈希不是原生归档哈希。
证据通过既有 Explore 写回并进入 replan 和研究历程；缺失测量保持未知，负结果
继续可用。该切片交付本地执行证据与阶段接续，原生提交、自动反馈依赖和成本
归约由后续组合切片接入。工程回归不证明首次分数或长期收益已经改善。
