import { useState } from 'react'
import { useSettingsStore, type VisualReviewMode } from '@/stores/settings'
import { testProviderConnection } from '@/services/connectionTester'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/**
 * Modal provider settings. Values commit to the settings store on every
 * change; focus trapping, Escape handling and overlay are provided by the
 * Dialog primitive.
 */
export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const settings = useSettingsStore()
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

  const testConnection = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await testProviderConnection({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        messages: [{ role: 'user', content: 'ping' }],
      })
      setTestResult(result.message)
    } finally {
      setTesting(false)
    }
  }

  const fieldLabel = 'grid gap-1 text-xs font-normal text-muted-foreground'

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Provider settings</DialogTitle>
          <DialogDescription>
            Browser-local developer configuration. The API key never leaves this browser except to
            your configured provider, and is never logged.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-2">
          <Label className={fieldLabel}>
            Base URL
            <Input
              placeholder="https://api.openai.com/v1"
              value={settings.baseUrl}
              onChange={(e) => settings.setSettings({ baseUrl: e.target.value })}
            />
          </Label>
          <Label className={fieldLabel}>
            API key (stored in this browser only)
            <Input
              type="password"
              placeholder="sk-…"
              value={settings.apiKey}
              onChange={(e) => settings.setSettings({ apiKey: e.target.value })}
            />
          </Label>
          <Label className={fieldLabel}>
            Model
            <Input
              placeholder="gpt-4o-mini"
              value={settings.model}
              onChange={(e) => settings.setSettings({ model: e.target.value })}
            />
          </Label>
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={testConnection} disabled={testing}>
              {testing ? 'Testing…' : 'Test connection'}
            </Button>
            {testResult && <span className="text-xs text-muted-foreground">{testResult}</span>}
          </div>
          <Label className="flex text-xs font-normal text-foreground">
            <Checkbox
              checked={settings.askBeforeDraw}
              onCheckedChange={(v) => settings.setSettings({ askBeforeDraw: Boolean(v) })}
            />
            Ask before drawing
          </Label>
          <Label className={fieldLabel}>
            Vision model (optional, for image attachments and screenshot review)
            <Input
              placeholder="Leave empty to use the model above"
              value={settings.visionModel}
              onChange={(e) => settings.setSettings({ visionModel: e.target.value })}
            />
          </Label>
          <Label className={fieldLabel}>
            Automatic visual review
            <Select
              value={settings.visualReviewMode}
              onValueChange={(v) =>
                settings.setSettings({ visualReviewMode: v as VisualReviewMode })
              }
            >
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="first">After the first artwork</SelectItem>
                <SelectItem value="always">After every build / edit</SelectItem>
                <SelectItem value="never">Never</SelectItem>
              </SelectContent>
            </Select>
          </Label>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
