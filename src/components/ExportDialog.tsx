import { useState } from 'react'
import {
  exportSvgDocument,
  exportPngDocument,
  buildFileName,
  clampPngWidth,
  clampPngScale,
  intrinsicAspectRatio,
  intrinsicDimensions,
  MIN_PNG_WIDTH,
  MAX_PNG_WIDTH,
} from '@/services/export'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

type Format = 'svg' | 'png'

interface ExportDialogProps {
  /** Current editor serialization (authoritative artwork). */
  svg: string
  /** Active project name used as the download file-name prefix. */
  projectName?: string
  onClose: () => void
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

/**
 * Modal export dialog: SVG or PNG output with PNG dimension/scale/background
 * options. Presentation-only; export logic lives in services/export. Focus
 * trapping, Escape handling and overlay are provided by the Dialog primitive.
 */
export function ExportDialog({ svg, projectName, onClose }: ExportDialogProps) {
  const [format, setFormat] = useState<Format>('svg')
  // Default to the canvas size so a 1x export matches the artwork exactly.
  const [widthInput, setWidthInput] = useState(() => String(intrinsicDimensions(svg)?.width ?? 640))
  const [scale, setScale] = useState('1')
  const [background, setBackground] = useState<'transparent' | 'white' | 'custom'>('transparent')
  const [customColor, setCustomColor] = useState('#ffffff')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const baseWidth = clampPngWidth(Number.parseInt(widthInput, 10))
  const scaleFactor = clampPngScale(Number.parseFloat(scale))
  const aspect = intrinsicAspectRatio(svg) ?? 0.75
  const outWidth = Math.min(MAX_PNG_WIDTH, Math.max(1, Math.round(baseWidth * scaleFactor)))
  const outHeight = Math.max(1, Math.round(outWidth * aspect))

  const resolveBackground = (): string | null =>
    background === 'transparent' ? null : background === 'white' ? '#ffffff' : customColor

  const onExport = async () => {
    if (busy) return
    setError(null)
    if (format === 'svg') {
      const result = exportSvgDocument(svg)
      if (!result.ok) {
        setError(result.error)
        return
      }
      downloadBlob(new Blob([result.svg], { type: 'image/svg+xml' }), buildFileName('svg', { name: projectName }))
      onClose()
      return
    }
    setBusy(true)
    const result = await exportPngDocument(svg, {
      width: baseWidth,
      scale: scaleFactor,
      background: resolveBackground(),
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    downloadBlob(result.blob, buildFileName('png', { name: projectName }))
    onClose()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Export artwork</DialogTitle>
        </DialogHeader>

        <RadioGroup
          aria-label="Format"
          value={format}
          onValueChange={(v) => setFormat(v as Format)}
          className="grid grid-cols-2 gap-2"
        >
          {(['svg', 'png'] as const).map((f) => (
            <Label
              key={f}
              className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border px-2 py-1.5 text-xs font-medium uppercase transition-colors hover:bg-muted has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/5 has-data-[state=checked]:text-primary"
            >
              <RadioGroupItem value={f} />
              {f}
            </Label>
          ))}
        </RadioGroup>
        <p className="-mt-2 text-xs text-muted-foreground">
          {format === 'svg'
            ? 'Vector format that stays sharp at any size and remains editable in design tools.'
            : 'Raster image with a fixed pixel size, best for use in documents, chats, and web pages.'}
        </p>

        {format === 'png' && (
          <div className="grid gap-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Label htmlFor="export-width">Width</Label>
              <Input
                id="export-width"
                type="number"
                min={MIN_PNG_WIDTH}
                max={MAX_PNG_WIDTH}
                value={widthInput}
                onChange={(e) => setWidthInput(e.target.value)}
                className="h-7 w-24 px-2 text-xs"
              />
              px
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Label htmlFor="export-scale">Scale</Label>
              <Select value={scale} onValueChange={setScale}>
                <SelectTrigger id="export-scale" size="sm" className="ml-auto w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['0.25', '0.5', '1', '2', '4'].map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}x
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Label htmlFor="export-background">Background</Label>
              <Select
                value={background}
                onValueChange={(v) => setBackground(v as typeof background)}
              >
                <SelectTrigger id="export-background" size="sm" className="ml-auto w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="transparent">Transparent</SelectItem>
                  <SelectItem value="white">White</SelectItem>
                  <SelectItem value="custom">Custom…</SelectItem>
                </SelectContent>
              </Select>
              {background === 'custom' && (
                <input
                  type="color"
                  value={customColor}
                  onChange={(e) => setCustomColor(e.target.value)}
                  aria-label="Custom background color"
                  className="h-6 w-8 cursor-pointer rounded-md border border-input bg-transparent p-0.5"
                />
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Output size: {outWidth} × {outHeight} px
            </p>
          </div>
        )}

        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void onExport()} disabled={busy}>
            {busy ? 'Exporting…' : `Export ${format.toUpperCase()}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
