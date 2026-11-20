-- Optional post-run transport diagnostics; the waveforms and immutable result metadata are unchanged.
ALTER TABLE station_experiments ADD COLUMN immediate_upload TEXT;
