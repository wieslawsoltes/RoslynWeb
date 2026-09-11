// The source document stays managed: rendering never replaces its entity database.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using netDxf;
using netDxf.Blocks;
using netDxf.Entities;
using netDxf.Tables;

public static class NetDxfBridge
{
    private static readonly Dictionary<string, DxfDocument> Documents = new Dictionary<string, DxfDocument>();
    private static long nextId;
    private const int CurvePrecision = 192;
    private const int MaxBlockDepth = 64;

    static NetDxfBridge()
    {
        // DXF readers must also handle pre-Unicode files and legacy code pages.
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
    }

    public static string CreateSample()
    {
        var doc = new DxfDocument();
        var outline = new Layer("Plate") { Color = new AciColor((byte)93, (byte)189, (byte)255) };
        var holes = new Layer("Holes") { Color = new AciColor((byte)255, (byte)176, (byte)86) };
        var construction = new Layer("Construction") { Color = new AciColor((byte)112, (byte)139, (byte)166) };
        var detail = new Layer("Detail") { Color = new AciColor((byte)121, (byte)224, (byte)172) };
        doc.Entities.Add(new Polyline2D(new[] {
            new Polyline2DVertex(0, 0), new Polyline2DVertex(150, 0, 0.414213562373095),
            new Polyline2DVertex(160, 10), new Polyline2DVertex(160, 90, 0.414213562373095),
            new Polyline2DVertex(150, 100), new Polyline2DVertex(10, 100, 0.414213562373095),
            new Polyline2DVertex(0, 90)
        }, true) { Layer = outline });
        foreach (var position in new[] { new Vector2(20, 20), new Vector2(140, 20), new Vector2(20, 80), new Vector2(140, 80) })
            doc.Entities.Add(new Circle(position, 7) { Layer = holes });
        doc.Entities.Add(new Ellipse(new Vector2(80, 50), 62, 34) { Layer = detail, Rotation = 18 });
        doc.Entities.Add(new Arc(new Vector2(80, 50), 43, 205, 335) { Layer = holes });
        doc.Entities.Add(new Line(new Vector2(-12, 50), new Vector2(172, 50)) { Layer = construction });
        doc.Entities.Add(new Line(new Vector2(80, -12), new Vector2(80, 112)) { Layer = construction });
        doc.Entities.Add(new Solid(new Vector2(169, 5), new Vector2(182, 5), new Vector2(169, 18)) { Layer = detail });
        var bolt = new Block("Bolt") { Origin = new Vector3(0, 0, 0) };
        bolt.Entities.Add(new Circle(Vector2.Zero, 11) { Color = AciColor.ByBlock });
        var hex = Enumerable.Range(0, 6).Select(i => new Vector2(7 * Math.Cos(i * Math.PI / 3), 7 * Math.Sin(i * Math.PI / 3)));
        bolt.Entities.Add(new Polyline2D(hex, true) { Color = AciColor.ByBlock });
        doc.Entities.Add(new Insert(bolt, new Vector2(200, 75)) { Layer = detail, Rotation = 30 });
        // Nonuniform block scaling is intentionally exercised by the sample.
        doc.Entities.Add(new Insert(bolt, new Vector2(200, 35)) { Layer = holes, Scale = new Vector3(1.3, 0.8, 1), Rotation = -20 });
        return Register(doc);
    }

    public static string Load(string base64)
    {
        if (base64 == null) throw new ArgumentNullException(nameof(base64));
        using var stream = new MemoryStream(Convert.FromBase64String(base64), false);
        var document = DxfDocument.Load(stream);
        if (document == null) throw new InvalidDataException("netDxf could not load this DXF. The file may be invalid, truncated, or use an unsupported DXF version.");
        return Register(document);
    }

    public static string Scene(string handle)
    {
        var scene = BuildScene(Get(handle));
        return JsonSerializer.Serialize(new { handle, scene, stats = scene["stats"], issues = scene["issues"] });
    }

    public static string Export(string handle, bool binary)
    {
        using var stream = new MemoryStream();
        if (!Get(handle).Save(stream, binary)) throw new InvalidDataException("netDxf could not serialize this document.");
        return Convert.ToBase64String(stream.ToArray());
    }

    public static bool Dispose(string handle) { return handle != null && Documents.Remove(handle); }

    private static DxfDocument Get(string handle)
    {
        if (handle == null || !Documents.TryGetValue(handle, out var document)) throw new ArgumentException("Unknown or disposed DXF document handle.", nameof(handle));
        return document;
    }

    private static string Register(DxfDocument document)
    {
        string handle = "dxf-" + (++nextId).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var scene = BuildScene(document);
        // Serialization can reject non-finite coordinates accepted by netDxf.
        // Publish the handle only after its complete response can be returned.
        string response = JsonSerializer.Serialize(new { handle, scene, stats = scene["stats"], issues = scene["issues"] });
        Documents.Add(handle, document);
        return response;
    }

    private static Dictionary<string, object> BuildScene(DxfDocument document)
    {
        var scene = new SceneBuilder(document);
        foreach (var entity in document.Entities.All)
        {
            scene.SourceEntities++;
            scene.Visit(entity, Matrix3.Identity, Vector3.Zero, null, null, 1, 0, new HashSet<Block>(), Array.Empty<string>());
        }
        var layers = document.Layers.Select(layer => new { name = layer.Name, visible = layer.IsVisible && !layer.IsFrozen }).ToArray();
        return new Dictionary<string, object> {
            ["version"] = 1, ["entities"] = scene.Entities, ["layers"] = layers, ["issues"] = scene.Issues,
            ["stats"] = new { entityCount = scene.SourceEntities, layerCount = layers.Length, sourceEntities = scene.SourceEntities, renderedEntities = scene.Entities.Count, hiddenEntities = scene.HiddenEntities,
                unsupportedEntities = scene.UnsupportedEntities, layers = layers.Length, blocks = document.Blocks.Count, curvePrecision = CurvePrecision,
                layout = document.Entities.ActiveLayout },
        };
    }

    private static object Point(Vector3 p) { return new { x = p.X, y = p.Y, z = p.Z }; }
    private static Vector3 Ocs(Vector2 p, double elevation, Vector3 normal) { return MathHelper.ArbitraryAxis(normal) * new Vector3(p.X, p.Y, elevation); }

    private sealed class SceneBuilder
    {
        internal readonly List<Dictionary<string, object>> Entities = new List<Dictionary<string, object>>();
        internal readonly List<object> Issues = new List<object>();
        internal int SourceEntities, HiddenEntities, UnsupportedEntities;
        private readonly Dictionary<string, bool> layerVisibility;

        internal SceneBuilder(DxfDocument document)
        {
            layerVisibility = document.Layers.ToDictionary(layer => layer.Name,
                layer => layer.IsVisible && !layer.IsFrozen, StringComparer.OrdinalIgnoreCase);
        }

        private void Issue(EntityObject entity, string code, string message)
        {
            Issues.Add(new { code, entityType = entity.CodeName, handle = entity.Handle, message });
        }

        internal void Visit(EntityObject entity, Matrix3 transform, Vector3 translation, Layer inheritedLayer, AciColor inheritedColor,
            double inheritedOpacity, int depth, HashSet<Block> blockPath, IReadOnlyList<string> ancestorVisibilityLayers)
        {
            Layer layer = entity.Layer.Name == "0" && inheritedLayer != null ? inheritedLayer : entity.Layer;
            if (!entity.IsVisible) { HiddenEntities++; return; }
            // Keep layer-hidden geometry so clients can reveal it without reloading the document.
            // Every enclosing insert layer gates its descendants, even when a child uses another layer.
            var visibilityLayers = new List<string>(ancestorVisibilityLayers);
            if (!visibilityLayers.Contains(layer.Name, StringComparer.OrdinalIgnoreCase)) visibilityLayers.Add(layer.Name);
            if (visibilityLayers.Any(name => layerVisibility.TryGetValue(name, out var visible) && !visible)) HiddenEntities++;
            AciColor color = entity.Color.IsByLayer ? layer.Color : entity.Color.IsByBlock ? inheritedColor ?? new AciColor((short)7) : entity.Color;
            var transparency = entity.Transparency.IsByLayer ? layer.Transparency : entity.Transparency;
            double opacity = transparency.IsByBlock ? inheritedOpacity : transparency.IsByLayer ? 1 : 1 - transparency.Value / 100.0;
            var rgba = new[] { color.R / 255.0, color.G / 255.0, color.B / 255.0, opacity };
            Vector3 World(Vector3 p) { return transform * p + translation; }
            Dictionary<string, object> Shape(string type) { return new Dictionary<string, object> {
                ["type"] = type, ["layer"] = layer.Name, ["color"] = rgba, ["handle"] = entity.Handle ?? "", ["sourceType"] = entity.CodeName,
                ["visibilityLayers"] = visibilityLayers.ToArray()
            }; }
            void AddVertices(string type, IEnumerable<Vector3> points, bool closed = false)
            {
                var item = Shape(type); item["vertices"] = points.Select(p => Point(World(p))).ToArray(); item["closed"] = closed; Entities.Add(item);
            }
            void Segments(IEnumerable<Vector3> sequence, bool closed)
            {
                var points = sequence.ToArray();
                var vertices = new List<Vector3>();
                for (int i = 1; i < points.Length; i++) { vertices.Add(points[i - 1]); vertices.Add(points[i]); }
                if (closed && points.Length > 1) { vertices.Add(points[points.Length - 1]); vertices.Add(points[0]); }
                AddVertices("SEGMENTS", vertices);
            }
            bool root = depth == 0;
            try
            {
                switch (entity)
                {
                    case Insert insert:
                    {
                        if (depth >= MaxBlockDepth || !blockPath.Add(insert.Block))
                        { UnsupportedEntities++; Issue(entity, "DXF_BLOCK_RECURSION", "Cyclic or excessively nested block reference was retained but not rendered."); return; }
                        try
                        {
                            var local = insert.GetTransformation();
                            var combined = transform * local;
                            var offset = World(insert.Position - local * insert.Block.Origin);
                            foreach (var child in insert.Block.Entities) Visit(child, combined, offset, layer, color, opacity, depth + 1, blockPath, visibilityLayers);
                            foreach (var attribute in insert.Attributes)
                            {
                                UnsupportedEntities++;
                                Issues.Add(new { code = "DXF_TEXT_NOT_RENDERED", entityType = "ATTRIB", handle = attribute.Handle,
                                    message = "Block attribute text is preserved in the DXF document; font shaping is not part of this geometry renderer." });
                            }
                        }
                        finally { blockPath.Remove(insert.Block); }
                        return;
                    }
                    case Dimension dimension:
                    {
                        if (dimension.Block == null)
                        { UnsupportedEntities++; Issue(entity, "DXF_DIMENSION_BLOCK_MISSING", "This dimension has no saved drawing block; automatic dimension layout is not performed by the renderer."); return; }
                        if (depth >= MaxBlockDepth || !blockPath.Add(dimension.Block))
                        { UnsupportedEntities++; Issue(entity, "DXF_BLOCK_RECURSION", "Cyclic or excessively nested dimension drawing block was retained but not rendered."); return; }
                        try
                        {
                            var plane = MathHelper.ArbitraryAxis(dimension.Normal);
                            var combined = transform * plane;
                            var offset = World(plane * (new Vector3(0, 0, dimension.Elevation) - dimension.Block.Origin));
                            foreach (var child in dimension.Block.Entities)
                                Visit(child, combined, offset, layer, color, opacity, depth + 1, blockPath, visibilityLayers);
                        }
                        finally { blockPath.Remove(dimension.Block); }
                        return;
                    }
                    case Leader leader:
                        AddVertices("POLYLINE", leader.Vertexes.Select(p => Ocs(p, leader.Elevation, leader.Normal)));
                        if (leader.ShowArrowhead || leader.PathType == LeaderPathType.Spline)
                            Issue(entity, "DXF_LEADER_PATH_ONLY", "Leader vertices are rendered as a polyline; arrowhead styling and spline interpolation remain in the DXF document.");
                        return;
                    case Wipeout wipeout:
                    {
                        var boundary = wipeout.ClippingBoundary.Vertexes;
                        IEnumerable<Vector2> points = boundary;
                        if (wipeout.ClippingBoundary.Type == ClippingBoundaryType.Rectangular)
                        {
                            var a = boundary[0]; var b = boundary[1];
                            points = new[] { a, new Vector2(b.X, a.Y), b, new Vector2(a.X, b.Y) };
                        }
                        AddVertices("POLYLINE", points.Select(p => Ocs(p, wipeout.Elevation, wipeout.Normal)), true);
                        Issue(entity, "DXF_WIPEOUT_BOUNDARY_ONLY", "Wipeout boundaries are rendered; masking and draw-order occlusion are preserved in the DXF but are not applied by this renderer.");
                        return;
                    }
                    case Line line:
                    {
                        var item = Shape("LINE"); item["start"] = Point(World(line.StartPoint)); item["end"] = Point(World(line.EndPoint)); Entities.Add(item); return;
                    }
                    case Circle circle:
                    {
                        if (!root) { Segments(circle.PolygonalVertexes(CurvePrecision).Select(p => circle.Center + Ocs(p, 0, circle.Normal)), true); return; }
                        var item = Shape("CIRCLE"); item["center"] = Point(circle.Center); item["radius"] = circle.Radius; item["normal"] = Point(circle.Normal); Entities.Add(item); return;
                    }
                    case Arc arc:
                    {
                        if (!root) { Segments(arc.PolygonalVertexes(CurvePrecision).Select(p => arc.Center + Ocs(p, 0, arc.Normal)), false); return; }
                        var item = Shape("ARC"); item["center"] = Point(arc.Center); item["radius"] = arc.Radius; item["startAngle"] = arc.StartAngle; item["endAngle"] = arc.EndAngle; item["normal"] = Point(arc.Normal); Entities.Add(item); return;
                    }
                    case Ellipse ellipse:
                    {
                        if (!root) { Segments(ellipse.PolygonalVertexes(CurvePrecision).Select(p => ellipse.Center + Ocs(p, 0, ellipse.Normal)), ellipse.IsFullEllipse); return; }
                        double angle = ellipse.Rotation * Math.PI / 180;
                        double Parameter(double polar) { double a = polar * Math.PI / 180; return Math.Atan2(Math.Sin(a) / ellipse.MinorAxis, Math.Cos(a) / ellipse.MajorAxis) * 180 / Math.PI; }
                        var item = Shape("ELLIPSE"); item["center"] = Point(ellipse.Center); item["majorAxis"] = Point(Ocs(new Vector2(Math.Cos(angle) * ellipse.MajorAxis / 2, Math.Sin(angle) * ellipse.MajorAxis / 2), 0, ellipse.Normal));
                        item["ratio"] = ellipse.MinorAxis / ellipse.MajorAxis; item["normal"] = Point(ellipse.Normal); item["startAngle"] = ellipse.IsFullEllipse ? 0 : Parameter(ellipse.StartAngle); item["endAngle"] = ellipse.IsFullEllipse ? 360 : Parameter(ellipse.EndAngle); Entities.Add(item); return;
                    }
                    case Polyline2D polyline:
                    {
                        if (polyline.Vertexes.Any(v => v.StartWidth != 0 || v.EndWidth != 0)) Issue(entity, "DXF_POLYLINE_WIDTH", "Variable-width polyline is rendered as its centerline; widths remain in the DXF document.");
                        if (!root || polyline.SmoothType != PolylineSmoothType.NoSmooth || Math.Abs(polyline.Normal.Z - 1) > 1e-12)
                        {
                            foreach (var part in polyline.Explode()) Visit(part, transform, translation, layer, color, opacity, Math.Max(1, depth), blockPath, visibilityLayers);
                            return;
                        }
                        var item = Shape("LWPOLYLINE"); item["vertices"] = polyline.Vertexes.Select(v => new { x = v.Position.X, y = v.Position.Y, z = polyline.Elevation, bulge = v.Bulge }).ToArray();
                        item["closed"] = polyline.IsClosed; item["normal"] = Point(polyline.Normal); Entities.Add(item); return;
                    }
                    case Polyline3D polyline:
                        if (polyline.SmoothType == PolylineSmoothType.NoSmooth) AddVertices("POLYLINE", polyline.Vertexes, polyline.IsClosed);
                        else Segments(polyline.PolygonalVertexes(CurvePrecision), polyline.IsClosed);
                        return;
                    case Solid solid:
                        // SOLID/TRACE's DXF vertex order is a strip, not polygon winding.
                        AddVertices("SOLID", new[] { Ocs(solid.FirstVertex, solid.Elevation, solid.Normal), Ocs(solid.SecondVertex, solid.Elevation, solid.Normal), Ocs(solid.FourthVertex, solid.Elevation, solid.Normal), Ocs(solid.ThirdVertex, solid.Elevation, solid.Normal) }); return;
                    case Trace trace:
                        AddVertices("TRACE", new[] { Ocs(trace.FirstVertex, trace.Elevation, trace.Normal), Ocs(trace.SecondVertex, trace.Elevation, trace.Normal), Ocs(trace.FourthVertex, trace.Elevation, trace.Normal), Ocs(trace.ThirdVertex, trace.Elevation, trace.Normal) }); return;
                    case Face3D face:
                        AddVertices("3DFACE", new[] { face.FirstVertex, face.SecondVertex, face.ThirdVertex, face.FourthVertex }); return;
                    case netDxf.Entities.Point point:
                    {
                        var item = Shape("POINT"); item["position"] = Point(World(point.Position)); Entities.Add(item); return;
                    }
                    case Spline spline:
                        Segments(spline.PolygonalVertexes(CurvePrecision), spline.IsClosed || spline.IsClosedPeriodic); return;
                    case PolygonMesh polygonMesh:
                    {
                        const int surfacePrecision = 24;
                        bool smooth = polygonMesh.SmoothType != PolylineSmoothType.NoSmooth;
                        int u = smooth ? surfacePrecision : polygonMesh.U;
                        int v = smooth ? surfacePrecision : polygonMesh.V;
                        var points = polygonMesh.MeshVertexes(surfacePrecision, surfacePrecision);
                        var edges = new List<Vector3>();
                        for (int row = 0; row < v; row++)
                        for (int column = 0; column < u; column++)
                        {
                            int index = row * u + column;
                            if (column + 1 < u || polygonMesh.IsClosedInU)
                            { edges.Add(points[index]); edges.Add(points[row * u + (column + 1) % u]); }
                            if (row + 1 < v || polygonMesh.IsClosedInV)
                            { edges.Add(points[index]); edges.Add(points[((row + 1) % v) * u + column]); }
                        }
                        AddVertices("SEGMENTS", edges);
                        return;
                    }
                    case Mesh mesh:
                        foreach (var face in mesh.Faces)
                        {
                            var points = face.Select(index => mesh.Vertexes[index]).ToArray();
                            Segments(points, true);
                        }
                        if (mesh.SubdivisionLevel != 0) Issue(entity, "DXF_MESH_SUBDIVISION", "The mesh control cage is rendered; subdivision surface evaluation is not implemented.");
                        return;
                    case PolyfaceMesh polyface:
                        foreach (var part in polyface.Explode()) Visit(part, transform, translation, layer, color, opacity, depth, blockPath, visibilityLayers);
                        return;
                    case Hatch hatch:
                    {
                        var hatchTransform = transform * MathHelper.ArbitraryAxis(hatch.Normal);
                        var hatchOffset = World(Ocs(Vector2.Zero, hatch.Elevation, hatch.Normal));
                        foreach (var boundary in hatch.BoundaryPaths)
                        foreach (var edge in boundary.Edges)
                        {
                            var part = edge.ConvertTo();
                            part.Layer = layer; part.Color = color;
                            Visit(part, hatchTransform, hatchOffset, layer, color, opacity, Math.Max(1, depth), blockPath, visibilityLayers);
                        }
                        Issue(entity, "DXF_HATCH_BOUNDARY_ONLY", "Hatch boundaries are rendered; pattern and solid hatch fills are preserved in the DXF but are not tessellated by this adapter.");
                        return;
                    }
                    case MLine mline:
                        foreach (var part in mline.Explode()) Visit(part, transform, translation, layer, color, opacity, depth, blockPath, visibilityLayers);
                        return;
                    default:
                        UnsupportedEntities++;
                        Issue(entity, "DXF_ENTITY_NOT_RENDERED", "This entity is preserved by netDxf for full document round-trip but is not rendered by the geometry adapter.");
                        return;
                }
            }
            catch (Exception error)
            {
                UnsupportedEntities++;
                Issue(entity, "DXF_GEOMETRY_ERROR", "Geometry conversion failed; original entity is preserved: " + error.Message);
            }
        }
    }
}
