using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using netDxf;
using netDxf.Entities;
using netDxf.Header;
using netDxf.Tables;

// These are the only entry points used by the differential test. The same
// unchanged netDxf DLL executes in managed .NET Wasm, generated JS, and native
// Wasm. Integer arrays transport byte values identically through the managed
// JSON bridge and the generated runtimes, without incidental base64 helpers,
// shared documents, streams, or runtime object handles.
public static class NetDxfDocumentFixture
{
    private static DxfVersion Version(int year)
    {
        switch (year)
        {
            case 2000: return DxfVersion.AutoCad2000;
            case 2004: return DxfVersion.AutoCad2004;
            case 2007: return DxfVersion.AutoCad2007;
            case 2010: return DxfVersion.AutoCad2010;
            case 2013: return DxfVersion.AutoCad2013;
            case 2018: return DxfVersion.AutoCad2018;
            default: throw new ArgumentOutOfRangeException(nameof(year));
        }
    }

    public static int[] Write(int year, bool binary, string layerName, string text)
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        var document = new DxfDocument(Version(year));
        var layer = new Layer(layerName) { Color = new AciColor(3) };
        document.Entities.Add(new Line(new Vector3(1.25, -2.5, 3.75), new Vector3(1000.125, 20.5, -6.25))
        {
            Layer = layer, Thickness = 0.375, LinetypeScale = 2.5
        });
        document.Entities.Add(new Circle(new Vector3(4.25, 5.5, 6.75), 2.125) { Layer = layer });
        document.Entities.Add(new Arc(new Vector3(-10.5, 3.125, -4.25), 7.75, 350, 25.5) { Layer = layer });
        var polyline = new Polyline2D(new[]
        {
            new Polyline2DVertex(0, 0) { Bulge = 0.5, StartWidth = 0.25, EndWidth = 0.75 },
            new Polyline2DVertex(10.25, 0),
            new Polyline2DVertex(10.25, 5.5) { Bulge = -0.125 },
            new Polyline2DVertex(0, 5.5)
        }, true) { Layer = layer, Elevation = 2.25, Thickness = 0.5 };
        document.Entities.Add(polyline);
        document.Entities.Add(new Text(text, new Vector3(-3.25, 4.5, 1.75), 2.5)
        {
            Layer = layer, Rotation = 27.5, WidthFactor = 0.875
        });
        document.Entities.Add(new MText(text + @"\PSecond paragraph 123", new Vector3(7.25, -8.5, 2.75), 1.25, 30.5)
        {
            Layer = layer, Rotation = 12.5
        });
        using (var output = new MemoryStream())
        {
            if (!document.Save(output, binary))
                throw new InvalidOperationException("netDxf document Save returned false.");
            var bytes = output.ToArray();
            var values = new int[bytes.Length];
            for (int i = 0; i < bytes.Length; i++) values[i] = bytes[i];
            return values;
        }
    }

    private static void Number(List<string> result, double value)
    {
        result.Add(value.ToString("R", CultureInfo.InvariantCulture));
    }

    private static void Point(List<string> result, Vector3 value)
    {
        Number(result, value.X);
        Number(result, value.Y);
        Number(result, value.Z);
    }

    private static void Entity(List<string> result, string type, EntityObject entity)
    {
        result.Add(type);
        result.Add(entity.Layer.Name);
        Number(result, entity.Layer.Color.Index);
    }

    // The signature deliberately excludes handles, comments, and timestamps.
    // It preserves entity counts, version, layer assignment/color, coordinates,
    // polyline flags/bulges/widths, and exact single/multiline text values.
    public static string[] Read(int[] values)
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        var bytes = new byte[values.Length];
        for (int i = 0; i < values.Length; i++) bytes[i] = checked((byte)values[i]);
        using (var input = new MemoryStream(bytes))
        {
            var document = DxfDocument.Load(input);
            if (document == null)
                throw new InvalidOperationException("netDxf document Load returned null.");
            var result = new List<string>();
            result.Add(document.DrawingVariables.AcadVer.ToString());
            Number(result, document.Entities.All.Count());
            Number(result, document.Layers.Count);
            Number(result, document.Entities.Lines.Count());
            Number(result, document.Entities.Circles.Count());
            Number(result, document.Entities.Arcs.Count());
            Number(result, document.Entities.Polylines2D.Count());
            Number(result, document.Entities.Texts.Count());
            Number(result, document.Entities.MTexts.Count());

            var line = document.Entities.Lines.Single();
            Entity(result, "LINE", line);
            Point(result, line.StartPoint);
            Point(result, line.EndPoint);
            Number(result, line.Thickness);
            Number(result, line.LinetypeScale);

            var circle = document.Entities.Circles.Single();
            Entity(result, "CIRCLE", circle);
            Point(result, circle.Center);
            Number(result, circle.Radius);

            var arc = document.Entities.Arcs.Single();
            Entity(result, "ARC", arc);
            Point(result, arc.Center);
            Number(result, arc.Radius);
            Number(result, arc.StartAngle);
            Number(result, arc.EndAngle);

            var polyline = document.Entities.Polylines2D.Single();
            Entity(result, "LWPOLYLINE", polyline);
            result.Add(polyline.IsClosed ? "closed" : "open");
            Number(result, polyline.Elevation);
            Number(result, polyline.Thickness);
            Number(result, polyline.Vertexes.Count);
            foreach (var vertex in polyline.Vertexes)
            {
                Number(result, vertex.Position.X);
                Number(result, vertex.Position.Y);
                Number(result, vertex.Bulge);
                Number(result, vertex.StartWidth);
                Number(result, vertex.EndWidth);
            }

            var text = document.Entities.Texts.Single();
            Entity(result, "TEXT", text);
            result.Add(text.Value);
            Point(result, text.Position);
            Number(result, text.Height);
            Number(result, text.Rotation);
            Number(result, text.WidthFactor);

            var mtext = document.Entities.MTexts.Single();
            Entity(result, "MTEXT", mtext);
            result.Add(mtext.Value);
            Point(result, mtext.Position);
            Number(result, mtext.Height);
            Number(result, mtext.RectangleWidth);
            Number(result, mtext.Rotation);
            return result.ToArray();
        }
    }
}
