import type { AttributeControl } from '@/svg/attributes'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface AttributeControlsProps {
  controls: AttributeControl[]
  values: Record<string, string | number | boolean>
  onChange: (id: string, value: string | number | boolean) => void
}

/** "Suggested parameters" grid proposed by the latest assistant message. */
export function AttributeControls({ controls, values, onChange }: AttributeControlsProps) {
  return (
    <div className="border-t px-3 py-2">
      <div className="mb-1 text-[11px] font-medium text-muted-foreground">Suggested parameters</div>
      <div className="grid max-h-40 grid-cols-2 gap-2 overflow-y-auto">
        {controls.map((c) => (
          <Label key={c.id} className="items-center gap-1 text-xs font-normal">
            <span className="w-20 shrink-0 truncate font-normal text-muted-foreground" title={c.label}>
              {c.label}
            </span>
            {c.type === 'select' ? (
              <Select
                value={String(values[c.id])}
                onValueChange={(v) => onChange(c.id, v)}
              >
                <SelectTrigger size="sm" className="min-w-0 flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {c.options!.map((o) => (
                    <SelectItem key={o.id} value={o.label}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : c.type === 'boolean' ? (
              <Checkbox
                checked={Boolean(values[c.id])}
                onCheckedChange={(v) => onChange(c.id, Boolean(v))}
              />
            ) : c.type === 'color' ? (
              <input
                type="color"
                value={String(values[c.id])}
                onChange={(e) => onChange(c.id, e.target.value)}
                className="h-6 w-8 cursor-pointer rounded-md border border-input bg-transparent p-0.5"
              />
            ) : c.type === 'number' ? (
              <Input
                type="number"
                className="h-7 w-16 px-1 text-xs"
                value={Number(values[c.id])}
                min={c.min}
                max={c.max}
                step={c.step}
                onChange={(e) => onChange(c.id, Number(e.target.value))}
              />
            ) : (
              <Input
                type="text"
                className="h-7 min-w-0 flex-1 px-1 text-xs"
                value={String(values[c.id])}
                onChange={(e) => onChange(c.id, e.target.value)}
              />
            )}
          </Label>
        ))}
      </div>
    </div>
  )
}
